import axios from 'axios';
import * as dotenv from 'dotenv';
import type { Message } from '../types/index.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { getHierarchicalContext } from '../context/project-context.js';
import type { BridgeClient } from '../client.js';

dotenv.config();

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL = process.env.MODEL || 'deepseek/deepseek-v4-flash';

export class Subagent {
    private toolRegistry: ToolRegistry;
    private projectRoot: string;
    private client: BridgeClient;

    constructor(toolRegistry: ToolRegistry, projectRoot: string, client: BridgeClient) {
        this.toolRegistry = toolRegistry;
        this.projectRoot = projectRoot;
        this.client = client;
    }

    public async run(prompt: string, type: string = "general", name: string = "worker", activeScene: string = ""): Promise<string> {
        console.log(`[Subagent] Starting new [${type}] subagent for task: ${prompt}`);
        const agentId = `sub_${name}_${Math.floor(Math.random()*10000)}`;

        this.client.sendNotification('agent_event', { 
            type: 'subagent_start', 
            agentId: agentId, 
            message: `Starting ${type} subagent...`,
            title: prompt 
        });
        
        const projectContext = await getHierarchicalContext(this.projectRoot, activeScene);
        
        let typePrompt = "You are a specialized subagent for generic problem solving.";
        if (type === "code-reviewer") {
            typePrompt = "You are an independent Code Reviewer agent. Review code for safety, scalability, best practices, and correctness. Report findings concisely. Do NOT make edits yourself unless specifically asked in the prompt.";
        } else if (type === "implementer") {
            typePrompt = "You are an Implementation agent. Your job is to strictly follow instructions to write code, build components, and test the project. Work systematically.";
        }

        const sysPrompt = `${typePrompt}\nYour goal is to solve a specific subtask and report back a concise summary.
You have access to tools like reading files, modifying files, and performing diagnostic checks. 

## Best Practices
1. **Architecture Discovery**: Use \`grep_symbols\` to find function signatures before calling them.
2. **Quality Assurance**: Use available validation tools after any edit to verify correctness.
3. **Concision**: Report only the necessary details to the Coordinator.

PROJECT_SPECIFIC_GUIDANCE:
${projectContext || "None"}

ACTIVE_SCENE: ${activeScene || "None"}`;

        const messages: Message[] = [
            { role: 'system', content: sysPrompt },
            { role: 'user', content: prompt }
        ];

        // Ensure we filter out 'agent' to prevent recursive explosions
        const tools = this.toolRegistry.getToolDefinitions().filter((t: any) => t.function.name !== 'agent');

        const maxIterations = 30;
        for (let i = 0; i < maxIterations; i++) {
            const res = await this.callOpenRouter(messages, tools);
            if (!res.choices || res.choices.length === 0) {
                this.client.sendNotification('agent_event', { type: 'subagent_end', agentId: agentId, message: "Error" });
                return "[Subagent Error] No choices from API.";
            }
            const message = res.choices[0].message;

            if (message.content === null || message.content === undefined) {
                message.content = '';
            }

            if (message.tool_calls && message.tool_calls.length > 0) {
                // Add assistant message
                messages.push(message);

                // If the model provided reasoning alongside tool calls, log it!
                if (message.content) {
                    this.client.sendNotification('agent_event', { 
                        type: 'subagent_tool', 
                        agentId: agentId, 
                        message: `[Reasoning] ${message.content}` 
                    });
                }

                // Execute tools
                for (const toolCall of message.tool_calls as any[]) {
                    const toolName = toolCall.function.name;
                    const args = JSON.parse(toolCall.function.arguments);
                    console.log(`[Subagent Tool] ${toolName}`);
                    
                    this.client.sendNotification('agent_event', { 
                        type: 'subagent_tool', 
                        agentId: agentId, 
                        message: `Running ${toolName}...` 
                    });

                    try {
                        const result = await this.toolRegistry.execute(toolName, args);
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: typeof result === 'string' ? result : JSON.stringify(result)
                        });
                    } catch(err: any) {
                        messages.push({
                            role: 'tool',
                            tool_call_id: toolCall.id,
                            name: toolName,
                            content: `[Subagent Tool Error] ${err.message}`
                        });
                    }
                }
            } else if (message.content) {
                console.log(`[Subagent] Completed with summary.`);
                this.client.sendNotification('agent_event', { type: 'subagent_end', agentId: agentId, message: "Completed" });
                return message.content;
            } else {
                this.client.sendNotification('agent_event', { type: 'subagent_end', agentId: agentId, message: "Error" });
                return "[Subagent Error] Empty response and no tool calls.";
            }
        }
        
        this.client.sendNotification('agent_event', { type: 'subagent_end', agentId: agentId, message: "Timeout" });
        return "[Subagent] Iteration limit reached without final conclusion.";
    }

    private async callOpenRouter(messages: Message[], tools: any[], retries = 3) {
        const provider = process.env.LLM_PROVIDER || 'openrouter';
        let apiKey = process.env.OPENROUTER_API_KEY;
        if (provider === 'siliconflow') {
            apiKey = process.env.SILICONFLOW_API_KEY;
        }
        
        const model = process.env.MODEL || 'google/gemini-3-flash-preview';
        
        let url = 'https://openrouter.ai/api/v1/chat/completions';
        if (provider === 'siliconflow') {
            url = 'https://api.siliconflow.cn/v1/chat/completions';
        }

        for (let i = 0; i < retries; i++) {
            try {
                const res = await axios.post(
                    url,
                    {
                        model: model,
                        messages: messages,
                        tools: tools.length > 0 ? tools : undefined,
                        tool_choice: tools.length > 0 ? 'auto' : undefined
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'HTTP-Referer': 'https://github.com/ksanadock/ksanadock',
                            'X-Title': 'KsanaDock Subagent',
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
                console.warn(`[Subagent] API request failed (${err.message}). Retry ${i+1}/${retries}...`);
                if (i === retries - 1) throw err;
                await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1))); // Exponential backoff
            }
        }
    }
}
