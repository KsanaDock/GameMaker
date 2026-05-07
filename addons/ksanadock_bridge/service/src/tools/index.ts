import { ToolRegistry } from './tool-registry.js';
import { registerFileTools } from './file-tools.js';
import { registerPatchTools } from './patch-tools.js';
import { BridgeClient } from '../client.js';
import { registerPlanningTools } from './planning-tools.js';
import { registerSubagentTools } from './subagent-tools.js';
import { registerSymbolTools } from './symbol-tools.js';
import { registerVisionTools } from './vision-tools.js';
import { registerResearchTools } from './research-tools.js';
import { registerShellTools } from './shell-tools.js';
import { registerCheckpointTools } from './checkpoint-tools.js';
import { registerStructuredEditTools } from './structured-edit-tools.js';
import { registerGodotTools } from './godot-tools.js';

export function setupTools(client: BridgeClient, projectRoot: string): ToolRegistry {
    const registry = new ToolRegistry();
    registerFileTools(registry, projectRoot);
    registerPatchTools(registry, projectRoot);
    registerPlanningTools(registry, projectRoot);
    registerSubagentTools(registry, projectRoot, client);
    registerSymbolTools(registry, projectRoot);
    registerVisionTools(registry, projectRoot);
    registerResearchTools(registry, projectRoot);
    registerShellTools(registry, projectRoot);
    registerCheckpointTools(registry, projectRoot);
    registerStructuredEditTools(registry, projectRoot);
    registerGodotTools(registry, projectRoot);
    return registry;
}
