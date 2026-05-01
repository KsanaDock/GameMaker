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

    constructor(client: BridgeClient, toolRegistry: ToolRegistry, projectRoot: string) {
        this.client = client;
        this.toolRegistry = toolRegistry;
        this.projectRoot = projectRoot;
        this.sessionStore = new SessionStore(this.projectRoot);
    }

    private getSOP(): string {
        return `You are a powerful AI Coding Architect. 
Your goal is to help the user build and maintain their software project with elite engineering standards.

## The Elite Architect's Mindset
1. **Architecture First**: Always seek to understand the project structure and existing symbols before making changes. NEVER guess.
2. **Master Planning**: Create a clear plan before starting implementation. For non-trivial requests, you MUST use the \`task_create\` tool to build a task list.
3. **Skill-Driven**: Use available skills for complex, domain-specific tasks.
4. **Verification**: Always verify your work through validation tools, tests, or dry runs.
5. **Communication**: ALWAYS explain your plan and reasoning in your message content (markdown) BEFORE or ALONGSIDE using any tools. NEVER send a message with tool calls but no content when starting or updating a task.

Available Subagents:
- code-reviewer: Independent code review and architecture analysis
- implementer: Systematically writes code and handles project modifications
- general: General-purpose subprocess`;
    }

    public async initializeSession(activeScene: string) {
        this.activeScene = activeScene;
        const projectContext = await getHierarchicalContext(this.projectRoot, activeScene);
        const autoMemory = await buildMemoryPrompt(this.projectRoot);
        
        let symbolMap = "Symbol scan pending...";
        try {
            symbolMap = await this.toolRegistry.execute('grep_symbols', {});
        } catch(e) {}
        
        const systemPrompt: Message = { 
            role: 'system', 
            content: `${this.getSOP()}\n\n${autoMemory}\n\nPROJECT_SYMBOL_MAP (LSP-LITE):\n${symbolMap}\n\nPROJECT_SPECIFIC_GUIDANCE:\n${projectContext || "None"}\n\nACTIVE_SCENE: ${activeScene || "None"}`
        };

        try {
            // Restore session if available
            const restored = await this.sessionStore.loadSession('current');
            if (restored && Array.isArray(restored) && restored.length > 0) {
                // Keep the NEW system prompt as the core context, but append history
                this.history = [systemPrompt, ...restored.filter(m => m.role !== 'system')];
                console.log(`[AgentLoop] Restored ${restored.length} messages from session.`);
            } else {
                this.history = [systemPrompt];
            }
        } catch(e) {
            this.history = [systemPrompt];
        }
    }

    public getHistory() {
        // Only return user/assistant/tool messages for UI rendering
        return this.history.filter(m => m.role !== 'system');
    }

    public pushMessage(msg: Message) {
        this.messageQueue.push(msg);
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
                    if (newMsg) this.history.push(newMsg);
                }

                // If the last message was assistant text (and not tool calls), we are idle waiting for user
                const lastMsg = this.history[this.history.length - 1];
                if (lastMsg && lastMsg.role === 'assistant' && (!lastMsg.tool_calls || lastMsg.tool_calls.length === 0)) {
                    break;
                }

                this.compactHistory();

                this.client.sendNotification('agent_event', { type: 'process_start', message: 'Agent is thinking...' });

                const res = await this.callOpenRouter();
                if (!res.choices || res.choices.length === 0) break;
                
                const message = res.choices[0].message;
                if (!message.content) message.content = '';

                // Handle tool calls
                if (message.tool_calls && message.tool_calls.length > 0) {
                    this.history.push(message);
                    
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
                    }
                    // Loop continues automatically because history now ends with role: 'tool'
                } else if (message.content) {
                    // Final text response
                    this.history.push(message);
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
            await this.sessionStore.saveSession('current', this.history as any);
            this.client.sendNotification('agent_event', { type: 'process_end', message: 'Agent idle.' });
            this.isRunning = false;
        }
    }

    private async callOpenRouter(retries = 3) {
        const tools = this.toolRegistry.getToolDefinitions();
        
        for (let i = 0; i < retries; i++) {
            try {
                const res = await axios.post(
                    'https://openrouter.ai/api/v1/chat/completions',
                    {
                        model: MODEL,
                        messages: this.history,
                        tools: tools.length > 0 ? tools : undefined,
                        tool_choice: tools.length > 0 ? 'auto' : undefined
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
                            'HTTP-Referer': 'https://github.com/ksanadock/ksanadock',
                            'X-Title': 'KsanaDock Loop Engine',
                            'Content-Type': 'application/json'
                        },
                        timeout: 120000 // 120s timeout
                    }
                );
                return res.data;
            } catch (err: any) {
                if (err.response && err.response.status === 400) {
                    throw err; // Don't retry validation errors
                }
                console.warn(`[AgentLoop] API request failed (${err.message}). Retry ${i+1}/${retries}...`);
                if (i === retries - 1) throw err;
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
            }
        }
    }
}
