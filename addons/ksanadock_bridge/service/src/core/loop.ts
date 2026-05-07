import axios from 'axios';
import * as dotenv from 'dotenv';
import type { Message, ContentPart } from '../types/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { getHierarchicalContext } from '../context/project-context.js';
import { buildMemoryPrompt } from './memory-system.js';
import { SessionStore } from '../memory/session-store.js';
import type { BridgeClient } from '../client.js';
import { isParallelSafeTool } from '../tools/tool-concurrency.js';
import { LLMRouter } from './llm-router.js';

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const SILICONFLOW_API_KEY = process.env.SILICONFLOW_API_KEY;
const XIAOMI_API_KEY = process.env.XIAOMI_API_KEY;
const ZAI_API_KEY = process.env.ZAI_API_KEY;
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
2. **Architecture First**: Always seek to understand the project structure and existing symbols before making changes. Batch independent read-only discovery calls together when possible. NEVER guess.
3. **Master Planning**: Create a clear plan before starting implementation. For non-trivial requests, you MUST use the \`phase_create\` tool to define your milestone, then use \`task_create\` with the resulting \`phase_id\` to build task-level steps.
4. **Phased Execution & Pausing (MANDATORY)**: Distinguish phases from tasks. A phase is a user-verifiable playable milestone; a task is an internal implementation step. Build one phase at a time, and each phase must end with a runnable game state. Phase 1 for a new game MUST be click-to-play: a valid main scene, visible player, camera, controls, at least one objective/threat, and no required editor setup. After completing a phase, update its status using \`phase_update\`, then STOP calling tools. Output what changed, what the user can play now, and ask the user to verify in Godot before continuing to the next phase.
5. **Skill-Driven**: Use available skills for complex, domain-specific tasks.
6. **Verification**: Verify the official playable project files. Do not create test scenes, test scripts, sample harnesses, or throwaway test folders. Use \`godot_validate\`, \`godot_import\`, and \`godot_run_script\` tools for headless validation — they auto-resolve the Godot executable without requiring PATH configuration. Fall back to static scene/script inspection and manual play instructions when headless is unavailable.
7. **Communication**: ALWAYS explain your plan and reasoning in your message content (markdown) BEFORE or ALONGSIDE using any tools. NEVER send a message with tool calls but no content when starting or updating a task.

## Playable Quality Gates
- Every phase must leave \`project.godot\` with a valid \`run/main_scene\` that opens the intended playable scene or menu.
- Do not expose debug/test buttons, \`scenes/test\`, \`scripts/test\`, \`test_scene.tscn\`, or \`ai_test_scene.tscn\` in user-facing game work.
- If a script has exported PackedScene dependencies, the scene must assign them or the script must preload sane defaults.
- If logic depends on groups such as \`player\`, \`enemy\`, or \`pickup\`, the corresponding scene roots must declare those groups.
- Cameras used by gameplay must be current or made current in code, and gameplay code must guard against missing cameras.
- Avoid placeholder \`pass\` functions in completed phase files unless the function is intentionally empty and documented by visible gameplay behavior.

## Research-Augmented Game Development
- When the user asks to create a new game, clone an existing genre, explore an unfamiliar mechanic, or build a non-trivial prototype, FIRST call \`collect_game_references\` before implementation.
- Generate practical search angles yourself: gameplay loop, control feel, progression, camera, UI, Godot implementation, and open-source examples.
- If the user explicitly asks for similar projects, code references, or GitHub examples, set \`cloneTopRepositories=true\` and keep \`maxRepositoriesToClone\` to 1 or 2 unless asked otherwise.
- After collecting references, read the generated files under \`.ksanadock/references/\` and use them to shape the MVP plan.
- External references are inspiration and context. Do not copy code, assets, shaders, music, or data into the game unless the license allows it and the user approves.
- Store all web summaries and cloned reference projects only under \`.ksanadock/references/\`; never mix external reference code into \`res://addons/\`, \`res://scripts/\`, or \`res://assets/\` directly.

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
        } catch (e) {
            console.warn(`[AgentLoop] Session restoration failed: ${e}`);
            this.history = [systemPrompt];
        }

        // Finalize system prompt in background
        Promise.all([projectContextPromise, autoMemoryPromise]).then(async ([context, memory]) => {
            let symbolMap = "Symbol scan pending...";
            try {
                // Background scan
                symbolMap = await this.toolRegistry.execute('grep_symbols', {});
            } catch (e) { }

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

    public hasUnfinishedTasks(): boolean {
        if (this.history.length <= 1) return false;
        const lastMsg = this.history[this.history.length - 1];
        if (!lastMsg) return false;

        // 1. 如果最后一条消息不是 assistant，说明 AI 还没说完（可能是 user 刚发，或者是 tool 刚返回结果）
        if (lastMsg.role !== 'assistant') return true;

        // 2. 如果最后一条是 assistant 但带有 tool_calls，说明正在等待工具执行
        if (lastMsg.role === 'assistant' && lastMsg.tool_calls && lastMsg.tool_calls.length > 0) return true;

        return false;
    }

    public pushMessage(msg: Message, images?: string[], checkpoint?: Message['checkpoint']) {
        if (images && images.length > 0) {
            msg = this.buildMultimodalMessage(msg, images);
        }
        if (checkpoint) {
            msg = { ...msg, checkpoint };
        }
        this.messageQueue.push(msg);
        // Pre-emptive save of the incoming message if added to history directly later
        this.wakeup();
    }

    private buildMultimodalMessage(msg: Message, images: string[]): Message {
        const textContent = typeof msg.content === 'string' ? msg.content : '';
        const parts: ContentPart[] = [
            { type: 'text', text: textContent }
        ];
        for (const base64Data of images) {
            // Detect mime type from base64 header or default to png
            let dataUrl = base64Data;
            if (!dataUrl.startsWith('data:')) {
                dataUrl = `data:image/png;base64,${base64Data}`;
            }
            parts.push({
                type: 'image_url',
                image_url: { url: dataUrl }
            });
        }
        return { ...msg, content: parts };
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

                    const toolResults = await this.executeToolCalls(message.tool_calls as any[]);
                    this.history.push(...toolResults);
                    await this.saveCurrentSession();

                    // Pause execution if the agent completed a phase
                    const shouldPause = (message.tool_calls as any[]).some((tc: any) => tc?.function?.name === 'phase_update' && tc?.function?.arguments?.includes('"completed"'));
                    if (shouldPause) {
                        this.client.sendNotification('agent_event', { type: 'system_notification', message: 'Phase completed. Paused for user review.' });
                        break;
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

    private async executeToolCalls(toolCalls: any[]): Promise<Message[]> {
        const results: Message[] = [];
        let readOnlyBatch: any[] = [];

        const flushReadOnlyBatch = async () => {
            if (readOnlyBatch.length === 0) return;
            const batch = readOnlyBatch;
            readOnlyBatch = [];
            if (batch.length > 1) {
                this.client.sendNotification('agent_event', {
                    type: 'tool_execution',
                    message: `Running ${batch.length} read-only tools in parallel...`
                });
            }
            results.push(...await Promise.all(batch.map(toolCall => this.executeSingleToolCall(toolCall))));
        };

        for (const toolCall of toolCalls) {
            const name = toolCall?.function?.name || '';
            if (isParallelSafeTool(name)) {
                readOnlyBatch.push(toolCall);
            } else {
                await flushReadOnlyBatch();
                results.push(await this.executeSingleToolCall(toolCall));
            }
        }

        await flushReadOnlyBatch();
        return results;
    }

    private async executeSingleToolCall(toolCall: any): Promise<Message> {
        const name = toolCall?.function?.name || 'unknown_tool';
        let args: any = {};

        try {
            args = JSON.parse(toolCall?.function?.arguments || '{}');
        } catch (err: any) {
            return {
                role: 'tool',
                tool_call_id: toolCall?.id || '',
                name,
                content: `Error parsing arguments for ${name}: ${err.message}`
            };
        }

        console.log(`[AgentLoop Executing] ${name}`);
        this.client.sendNotification('agent_event', { type: 'tool_execution', message: `Running ${name}...` });

        try {
            const result = await this.toolRegistry.execute(name, args);
            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                name,
                content: typeof result === 'string' ? result : JSON.stringify(result)
            };
        } catch (err: any) {
            return {
                role: 'tool',
                tool_call_id: toolCall.id,
                name,
                content: `Error executing ${name}: ${err.message}`
            };
        }
    }

    private async callLLM(retries = 3) {
        const tools = this.toolRegistry.getToolDefinitions();
        const route = LLMRouter.getRoute(this.currentProvider, this.currentApiKey);

        for (let i = 0; i < retries; i++) {
            try {
                const res = await axios.post(
                    route.url,
                    {
                        model: this.currentModel,
                        messages: this.history,
                        tools: tools.length > 0 ? tools : undefined,
                        tool_choice: tools.length > 0 ? 'auto' : undefined
                    },
                    {
                        headers: route.headers,
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
                console.warn(`[AgentLoop] API request failed (${err.message}). Retry ${i + 1}/${retries}...`);
                if (i === retries - 1) throw err;
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
            }
        }
    }
}
