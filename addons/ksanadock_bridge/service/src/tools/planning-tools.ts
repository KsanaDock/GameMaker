import type { ToolDefinition } from './tool-registry.js';
import { TaskManager } from '../core/task_manager.js';

let taskManagerInstance: TaskManager | null = null;
function getTasks(projectRoot: string) {
    if (!taskManagerInstance) taskManagerInstance = new TaskManager(projectRoot);
    return taskManagerInstance;
}

export function registerPlanningTools(registry: any, projectRoot: string) {
    registry.register({
        name: 'phase_create',
        description: 'Create a new development phase (milestone). Use this to define high-level playable goals before creating individual tasks.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Name of the phase (e.g., "Phase 1: MVP").' },
                description: { type: 'string', description: 'What this phase accomplishes for the player.' }
            },
            required: ['name']
        },
        handler: async (args: any) => {
            return getTasks(projectRoot).phaseCreate(args.name, args.description || '');
        }
    });

    registry.register({
        name: 'phase_update',
        description: 'Update the status of a development phase.',
        parameters: {
            type: 'object',
            properties: {
                phase_id: { type: 'number', description: 'The ID of the phase to update.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'The new status.' }
            },
            required: ['phase_id', 'status']
        },
        handler: async (args: any) => {
            return getTasks(projectRoot).phaseUpdate(args.phase_id, args.status);
        }
    });

    registry.register({
        name: 'phase_list',
        description: 'List all development phases.',
        parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => {
            return getTasks(projectRoot).phaseList();
        }
    });

    registry.register({
        name: 'phase_get',
        description: 'Get details of a specific phase.',
        parameters: {
            type: 'object',
            properties: { phase_id: { type: 'number' } },
            required: ['phase_id']
        },
        handler: async (args: any) => {
            return getTasks(projectRoot).phaseGet(args.phase_id);
        }
    });

    registry.register({
        name: 'task_create',
        description: 'Create a new persistent task in the DAG. Use this to break down complex goals into tracking steps.',
        parameters: {
            type: 'object',
            properties: {
                subject: { type: 'string', description: 'Brief title of the task (e.g., "Build Character Controller").' },
                description: { type: 'string', description: 'Detailed intention or scripts to modify.' },
                phase_id: { type: 'number', description: 'Optional phase ID to associate this task with.' }
            },
            required: ['subject']
        },
        handler: async (args: any) => {
            return getTasks(projectRoot).create(args.subject, args.description || '', args.phase_id);
        }
    });

    registry.register({
        name: 'task_update',
        description: 'Update the status or dependencies of an existing task. Setting status "completed" will automatically unblock dependent tasks.',
        parameters: {
            type: 'object',
            properties: {
                task_id: { type: 'number', description: 'The ID of the task to update.' },
                status: { type: 'string', enum: ['pending', 'in_progress', 'completed', 'failed'], description: 'The new status.' },
                add_blocked_by: { type: 'array', items: { type: 'number' }, description: 'Task IDs that must complete before this one.' },
                remove_blocked_by: { type: 'array', items: { type: 'number' }, description: 'Task IDs to unbind from.' }
            },
            required: ['task_id']
        },
        handler: async (args: any) => {
            return getTasks(projectRoot).update(args.task_id, args.status, args.add_blocked_by, args.remove_blocked_by);
        }
    });

    registry.register({
        name: 'task_list',
        description: 'List all persistent tasks in the DAG and their current states.',
        parameters: { type: 'object', properties: {}, required: [] },
        handler: async () => {
            return getTasks(projectRoot).listAll();
        }
    });

    registry.register({
        name: 'task_get',
        description: 'Get details of a specific task.',
        parameters: {
            type: 'object',
            properties: { task_id: { type: 'number' } },
            required: ['task_id']
        },
        handler: async (args: any) => {
            return getTasks(projectRoot).get(args.task_id);
        }
    });
}
