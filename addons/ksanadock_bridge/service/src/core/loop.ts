import axios from 'axios';
import * as dotenv from 'dotenv';
import type { Message } from '../types/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { getHierarchicalContext } from '../context/project-context.js';
import { buildMemoryPrompt } from './memory-system.js';
import { SessionStore } from '../memory/session-store.js';
import type { BridgeClient } from '../client.js';

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;
const MODEL = process.env.MODEL || 'deepseek/deepseek-v4-flash';

export class AgentLoop {
    private client: BridgeClient;
    private toolRegistry: ToolRegistry;
    private projectRoot: string;
    private sessionStore: SessionStore;
    private isRunning: boolean = false;
    private messageQueue: Message[] = [];
    private history: Message[] = [];
    private activeScene: string = "";

    private currentProvider: string = 'openrouter';
    private currentModel: string = process.env.MODEL || 'deepseek/deepseek-chat';
    private currentApiKey: string = process.env.OPENROUTER_API_KEY || '';

    constructor(client: BridgeClient, toolRegistry: ToolRegistry, projectRoot: string) {
        this.client = client;
        this.toolRegistry = toolRegistry;
        this.projectRoot = projectRoot;
        this.sessionStore = new SessionStore(this.projectRoot);
    }

    public updateConfig(provider: string, model: string, apiKey: string) {
        if (provider) {
            this.currentProvider = provider;
            process.env.LLM_PROVIDER = provider;
        }
        if (model) {
            this.currentModel = model;
            process.env.MODEL = model;
        }
        // Always update apiKey, even if empty, to allow fallback to env vars correctly
        this.currentApiKey = apiKey || '';
    }

    private getSOP(): string {
        return `You are a powerful AI Coding Architect for Godot Engine. 
Your goal is to help the user build and maintain their Godot project with elite engineering standards.

## Godot Project Architecture & Guidelines
When creating or organizing files, you MUST adhere to the standard directory structure:
- \`res://scenes/\`: For all Godot scenes (.tscn). Group by entity or system (e.g., \`scenes/player/\`, \`scenes/ui/\`).
- \`res://scripts/\`: For all GDScript files (.gd). Should closely mirror the \`scenes/\` folder structure.
- \`res://assets/\`: For all media (images, audio, models). Subdivide into \`assets/sprites/\`, \`assets/audio/\`, etc.
- \`res://resources/\`: For custom Godot Resource data files (.tres).
- **STRICT RULE**: NEVER place game logic or scenes in the root directory \`res://\` or inside \`res://addons/\`. Plugins and their code (inside addons/) should be completely ignored unless the user explicitly asks to modify a plugin.

## The Elite Architect's Mindset
1. **Visual-First & MVP Priority**: ALWAYS prioritize visible gameplay over complex backend architecture. NEVER create "invisible" nodes. For image assets, you MUST use \`analyze_image\` to determine grid dimensions (rows/cols) and animation sequences (idle, walk, etc.) before slicing them into \`AtlasTexture\` or configuring \`hframes\`/\`vframes\`. Use \`ColorRect\` placeholders only if no assets are found. Avoid "Ghost Scripts".
2. **Architecture First**: Always seek to understand the project structure and existing symbols before making changes. NEVER guess.
3. **Master Planning**: Create a clear plan before starting implementation. For non-trivial requests, you MUST use the \`task_create\` tool to build a task list.
4. **Phased Execution & Pausing (MANDATORY)**: NEVER implement a complex multi-step task in a single continuous loop. You MUST break the work into logical phases (e.g., "Phase 1: Basic Structure", "Phase 2: Core Logic"). After completing a phase, STOP calling tools. Output a plain text message detailing what you built, and explicitly ask the user to verify it in the Godot Editor or game runtime. Wait for the user's explicit approval or bug report before starting the next phase.
5. **Skill-Driven**: Use available skills for complex, domain-specific tasks.
6. **Verification**: Always verify your work through validation tools, tests, or dry runs before pausing.
7. **Communication**: ALWAYS explain your plan and reasoning in your message content (markdown) BEFORE or ALONGSIDE using any tools. NEVER send a message with tool calls but no content when starting or updating a task.

Available Subagents:
- code-reviewer: Independent code review and architecture analysis
- implementer: Systematically writes code and handles project modifications
- general: General-purpose subprocess`;
    }

    public async initializeSession(activeScene: string) {
        console.log(`[AgentLoop] Initializing session for scene: ${activeScene}`);
        this.activeScene = activeScene;
        
        // Non-blocking background tasks
        const projectContextPromise = getHierarchicalContext(this.projectRoot, activeScene);
        const autoMemoryPromise = buildMemoryPrompt(this.projectRoot);
        
        const systemPrompt: Message = { 
            role: 'system', 
            content: `${this.getSOP()}\n\n(Context pending...)\n\nACTIVE_SCENE: ${activeScene || "None"}`
        };

        try {
            // Restore session if available
            console.log(`[AgentLoop] Loading session memory...`);
            const restored = await this.sessionStore.loadSession('current');
            if (restored && Array.isArray(restored) && restored.length > 0) {
                const validHistory = restored
                    .filter(m => m && m.role && m.role !== 'system')
                    .map(m => ({
                        ...m,
                        role: m.role || 'assistant'
                    }));
                this.history = [systemPrompt, ...validHistory];
                console.log(`[AgentLoop] Restored ${validHistory.length} messages from history.`);
            } else {
                this.history = [systemPrompt];
            }
        } catch(e) {
            console.warn(`[AgentLoop] Session restoration failed: ${e}`);
            this.history = [systemPrompt];
        }

        // Finalize system prompt in background
        Promise.all([projectContextPromise, autoMemoryPromise]).then(async ([context, memory]) => {
            let symbolMap = "Symbol scan pending...";
            try {
                // Background scan
                symbolMap = await this.toolRegistry.execute('grep_symbols', {});
            } catch(e) {}

            // Directly update the object we created above - this is safer than indexing the array
            systemPrompt.content = `${this.getSOP()}\n\n${memory}\n\nPROJECT_SYMBOL_MAP (LSP-LITE):\n${symbolMap}\n\nPROJECT_SPECIFIC_GUIDANCE:\n${context || "None"}\n\nACTIVE_SCENE: ${this.activeScene || "None"}`;
            console.log(`[AgentLoop] Background context initialization complete.`);
        });
        
        await this.saveCurrentSession();
    }

    private async saveCurrentSession() {
        try {
            // Filter system prompt out of persistent storage to keep it fresh
            const toSave = this.history.filter(m => m.role !== 'system');
            await this.sessionStore.saveSession('current', toSave);
        } catch (e) {
            // Silent fail as requested, but we should ensure this.history is clean
        }
    }

    public getHistory() {
        // Only return user/assistant/tool messages for UI rendering
        return this.history.filter(m => m.role !== 'system');
    }

    public pushMessage(msg: Message) {
        this.messageQueue.push(msg);
        // Pre-emptive save of the incoming message if added to history directly later
        this.wakeup();
    }

    private wakeup() {
        if (!this.isRunning) {
            this.runLoop();
        }
    }

    private compactHistory() {
        const MAX_CHARS = 80000; // rough proxy for token budget
        const TARGET_CHARS = 50000;
        
        let currentChars = JSON.stringify(this.history).length;
        if (currentChars <= MAX_CHARS) return;

        console.log(`[AgentLoop] Compacting history from ${currentChars} chars...`);
        let sliceIndex = 1;
        while (currentChars > TARGET_CHARS && sliceIndex < this.history.length - 2) {
            const msg = this.history[sliceIndex];
            if (msg && msg.role === 'user') {
                let nextUserIdx = sliceIndex + 1;
                while (nextUserIdx < this.history.length) {
                    const nextMsg = this.history[nextUserIdx];
                    if (nextMsg && nextMsg.role === 'user') break;
                    nextUserIdx++;
                }
                if (nextUserIdx < this.history.length - 1) {
                    const dropped = this.history.slice(sliceIndex, nextUserIdx);
                    currentChars -= JSON.stringify(dropped).length;
                    sliceIndex = nextUserIdx;
                } else {
                    break;
                }
            } else {
                sliceIndex++;
            }
        }

        if (sliceIndex > 1) {
            const systemPrompt = this.history[0];
            const kept = this.history.slice(sliceIndex);
            
            const newHistory: Message[] = [];
            if (systemPrompt) newHistory.push(systemPrompt);
            newHistory.push({ role: 'user', content: '[System Note: Older conversation history has been truncated to maintain context window. Rely on your .ksanadock/memory directory for long-term context.]' });
            newHistory.push({ role: 'assistant', content: 'Understood. I will rely on the Auto Memory index (MEMORY.md) and tool searches for prior context.' });
            newHistory.push(...kept);
            
            this.history = newHistory;
            console.log(`[AgentLoop] History compacted to ${JSON.stringify(this.history).length} chars.`);
        }
    }

    private async runLoop() {
        this.isRunning = true;
        
        try {
            while (this.messageQueue.length > 0 || this.history[this.history.length - 1]?.role !== 'assistant') {
                // Drain queue into history
                while (this.messageQueue.length > 0) {
                    const newMsg = this.messageQueue.shift();
                    if (newMsg) {
                        this.history.push(newMsg);
                        await this.saveCurrentSession();
                    }
                }

                // If the last message was assistant text (and not tool calls), we are idle waiting for user
                const lastMsg = this.history[this.history.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && (!lastMsg.tool_calls || lastMsg.tool_calls.length === 0)) {
                    break;
                }

                this.compactHistory();

                // FINAL DEFENSE: Clean any messages with empty roles before sending to API
                this.history = this.history.filter(m => m); // Keep all messages
                this.history.forEach(m => {
                    const rawRole = (m as any).role;
                    if (!rawRole || rawRole === "") {
                        (m as any).role = "assistant"; 
                    }
                });

                this.client.sendNotification('agent_event', { type: 'process_start', message: 'Agent is thinking...' });

                const res = await this.callLLM();
                if (!res.choices || res.choices.length === 0) break;
                
                const message = res.choices[0].message;
                if (!(message as any).role) (message as any).role = 'assistant'; // Force assistant role
                if (!message.content) message.content = '';

                // Handle tool calls
                if (message.tool_calls && message.tool_calls.length > 0) {
                    this.history.push(message);
                    await this.saveCurrentSession();
                    
                    // If the model provided reasoning alongside tool calls, echo it back!
                    if (message.content) {
                        this.client.sendNotification('agent_reply', { text: message.content });
                    }

                    for (const toolCall of message.tool_calls as any[]) {
                        const name = toolCall.function.name;
                        const args = JSON.parse(toolCall.function.arguments);
                        console.log(`[AgentLoop Executing] ${name}`);
                        
                        this.client.sendNotification('agent_event', { type: 'tool_execution', message: `Running ${name}...` });

                        try {
                            const result = await this.toolRegistry.execute(name, args);
                            this.history.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: name,
                                content: typeof result === 'string' ? result : JSON.stringify(result)
                            });
                        } catch(err: any) {
                            this.history.push({
                                role: 'tool',
                                tool_call_id: toolCall.id,
                                name: name,
                                content: `Error executing ${name}: ${err.message}`
                            });
                        }
                        await this.saveCurrentSession();
                    }
                    // Loop continues automatically because history now ends with role: 'tool'
                } else if (message.content) {
                    // Final text response
                    this.history.push(message);
                    await this.saveCurrentSession();
                    this.client.sendNotification('agent_reply', { text: message.content });
                    // Loop will break on next iteration because last message is assistant text
                } else {
                    break; // Fallback
                }
            }
        } catch (err: any) {
            console.error("[AgentLoop Error]", err);
            this.client.sendNotification('agent_event', { type: 'error', message: err.message });
        } finally {
            await this.saveCurrentSession();
            this.client.sendNotification('agent_event', { type: 'process_end', message: 'Agent idle.' });
            this.isRunning = false;
        }
    }

    private async callLLM(retries = 3) {
        const tools = this.toolRegistry.getToolDefinitions();
        
        let url = 'https://openrouter.ai/api/v1/chat/completions';
        let apiKey = this.currentApiKey || process.env.OPENROUTER_API_KEY;
        
        if (this.currentProvider === 'siliconflow') {
            url = 'https://api.siliconflow.cn/v1/chat/completions';
            apiKey = this.currentApiKey || process.env.SILICONFLOW_API_KEY;
        }
        
        for (let i = 0; i < retries; i++) {
            try {
                const res = await axios.post(
                    url,
                    {
                        model: this.currentModel,
                        messages: this.history,
                        tools: tools.length > 0 ? tools : undefined,
                        tool_choice: tools.length > 0 ? 'auto' : undefined
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'HTTP-Referer': 'https://github.com/ksanadock/ksanadock',
                            'X-Title': 'KsanaDock Loop Engine',
                            'Content-Type': 'application/json'
                        },
                        timeout: 120000 // 120s timeout
                    }
                );
                return res.data;
            } catch (err: any) {
                if (err.response) {
                    console.error("[AgentLoop API Error Response]", JSON.stringify(err.response.data, null, 2));
                    if (err.response.status === 400 || err.response.status === 422) {
                        // Include the API's own error message if available
                        const apiError = err.response.data?.error?.message || err.response.data?.message || "";
                        if (apiError) {
                            err.message = `${err.message}: ${apiError}`;
                        }
                        throw err; 
                    }
                }
                console.warn(`[AgentLoop] API request failed (${err.message}). Retry ${i+1}/${retries}...`);
                if (i === retries - 1) throw err;
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
            }
        }
    }
}
