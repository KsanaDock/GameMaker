import * as path from 'path';
import { fileURLToPath } from 'url';
import { BridgeClient } from './client.js';
import { AgentLoop } from './core/loop.js';
import { setupTools } from './tools/index.js';
import { SkillManager } from './skills/skill-manager.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Calculate project root
let projectRoot = path.resolve(__dirname, '../../../../'); 

// Check for --project-root override
const projectRootArgIdx = process.argv.indexOf('--project-root');
const projectRootArgValue = projectRootArgIdx !== -1 ? process.argv[projectRootArgIdx + 1] : undefined;
if (projectRootArgValue) {
    projectRoot = path.resolve(projectRootArgValue);
}

async function main() {
    console.log('--- KsanaDock Agent Service Starting (V2 Architecture) ---');
    console.log('Project Root:', projectRoot);
    
    const client = new BridgeClient(9090);
    const toolRegistry = setupTools(client, projectRoot);
    const agentLoop = new AgentLoop(client, toolRegistry, projectRoot);
    
    // Load skills
    const skillManager = new SkillManager(projectRoot, toolRegistry, client);
    await skillManager.loadProjectSkills();

    let loopInitialized = false;

    // Register handlers for incoming requests from Godot
    client.onMethod('chat', async (params: any) => {
        const { message, active_scene, provider, model, api_key } = params;
        console.log('User Input:', message);
        console.log(`Provider: ${provider}, Model: ${model}, Using specific API Key: ${!!api_key}`);
        
        agentLoop.updateConfig(provider, model, api_key);
        
        if (!loopInitialized) {
            await agentLoop.initializeSession(active_scene || "");
            loopInitialized = true;
        }

        // Push message to the long-running loop
        agentLoop.pushMessage({ role: 'user', content: message });
        
        return { type: 'text', content: 'Task received by Agent Loop...' };
    });

    client.onMethod('get_history', async (params: any) => {
        const { active_scene } = params;
        console.log('[Agent Service] Received get_history request for scene:', active_scene);
        if (!loopInitialized) {
            await agentLoop.initializeSession(active_scene || "");
            loopInitialized = true;
        }
        return agentLoop.getHistory();
    });

    try {
        await client.connect();
        console.log('Ready to help build games! (Event-Driven Loop Engine active)');

        // Initial Ping
        const pong = await client.sendCommand('ping');
        console.log('Connection Test (Ping->Pong):', pong);

    } catch (err) {
        console.error('Core Service Error:', err);
        process.exit(1);
    }
}

main();
