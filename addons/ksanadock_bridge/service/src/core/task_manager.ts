import * as fs from 'fs';
import * as path from 'path';
import type { Task, TaskStatus, Phase } from '../types/index.js';
import { ensureKsanadockDirSync } from './project-data.js';

export class TaskManager {
    private taskDir: string;
    private phaseDir: string;
    private nextTaskId: number = 1;
    private nextPhaseId: number = 1;

    constructor(projectRoot: string) {
        const ksanadockDir = ensureKsanadockDirSync(projectRoot);
        this.taskDir = path.join(ksanadockDir, 'tasks');
        this.phaseDir = path.join(ksanadockDir, 'phases');
        
        if (!fs.existsSync(this.taskDir)) fs.mkdirSync(this.taskDir, { recursive: true });
        if (!fs.existsSync(this.phaseDir)) fs.mkdirSync(this.phaseDir, { recursive: true });

        this.nextTaskId = this.getMaxId(this.taskDir, 'task_') + 1;
        this.nextPhaseId = this.getMaxId(this.phaseDir, 'phase_') + 1;
    }

    private getMaxId(dir: string, prefix: string): number {
        const files = fs.readdirSync(dir).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
        if (files.length === 0) return 0;
        const ids = files.map(f => parseInt(f.replace(prefix, '').replace('.json', ''), 10));
        return Math.max(...ids);
    }

    private saveTask(task: Task) {
        const p = path.join(this.taskDir, `task_${task.id}.json`);
        fs.writeFileSync(p, JSON.stringify(task, null, 2), 'utf8');
    }

    private loadTask(id: number): Task {
        const p = path.join(this.taskDir, `task_${id}.json`);
        if (!fs.existsSync(p)) throw new Error(`Task ${id} not found.`);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    private savePhase(phase: Phase) {
        const p = path.join(this.phaseDir, `phase_${phase.id}.json`);
        fs.writeFileSync(p, JSON.stringify(phase, null, 2), 'utf8');
    }

    private loadPhase(id: number): Phase {
        const p = path.join(this.phaseDir, `phase_${id}.json`);
        if (!fs.existsSync(p)) throw new Error(`Phase ${id} not found.`);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    // Task Methods
    public create(subject: string, description: string = '', phaseId?: number): string {
        const task: Task = {
            id: this.nextTaskId++,
            subject,
            description,
            status: 'pending',
            blockedBy: [],
            phaseId
        };
        this.saveTask(task);
        return JSON.stringify(task, null, 2);
    }

    private clearDependency(completedId: number) {
        const files = fs.readdirSync(this.taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        for (const file of files) {
            const task = JSON.parse(fs.readFileSync(path.join(this.taskDir, file), 'utf8')) as Task;
            if (task.blockedBy.includes(completedId)) {
                task.blockedBy = task.blockedBy.filter(id => id !== completedId);
                this.saveTask(task);
            }
        }
    }

    public update(taskId: number, status?: TaskStatus, addBlockedBy?: number[], removeBlockedBy?: number[]): string {
        const task = this.loadTask(taskId);
        if (status) {
            task.status = status;
            if (status === 'completed') {
                this.clearDependency(taskId);
            }
        }
        if (addBlockedBy) {
            task.blockedBy = Array.from(new Set([...task.blockedBy, ...addBlockedBy]));
        }
        if (removeBlockedBy) {
            task.blockedBy = task.blockedBy.filter(id => !removeBlockedBy.includes(id));
        }
        this.saveTask(task);
        return JSON.stringify(task, null, 2);
    }

    public listAll(): string {
        const files = fs.readdirSync(this.taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        const tasks = files.map(f => JSON.parse(fs.readFileSync(path.join(this.taskDir, f), 'utf8')) as Task);
        return JSON.stringify(tasks, null, 2);
    }

    public get(taskId: number): string {
        return JSON.stringify(this.loadTask(taskId), null, 2);
    }

    // Phase Methods
    public phaseCreate(name: string, description: string = ''): string {
        const phase: Phase = {
            id: this.nextPhaseId++,
            name,
            description,
            status: 'pending'
        };
        this.savePhase(phase);
        return JSON.stringify(phase, null, 2);
    }

    public phaseUpdate(phaseId: number, status?: 'pending' | 'in_progress' | 'completed'): string {
        const phase = this.loadPhase(phaseId);
        if (status) phase.status = status;
        this.savePhase(phase);
        return JSON.stringify(phase, null, 2);
    }

    public phaseList(): string {
        const files = fs.readdirSync(this.phaseDir).filter(f => f.startsWith('phase_') && f.endsWith('.json'));
        const phases = files.map(f => JSON.parse(fs.readFileSync(path.join(this.phaseDir, f), 'utf8')) as Phase);
        return JSON.stringify(phases, null, 2);
    }

    public phaseGet(phaseId: number): string {
        return JSON.stringify(this.loadPhase(phaseId), null, 2);
    }

    public getUnfinishedTasks(): Task[] {
        if (!fs.existsSync(this.taskDir)) return [];
        const files = fs.readdirSync(this.taskDir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        return files
            .map(f => {
                try {
                    return JSON.parse(fs.readFileSync(path.join(this.taskDir, f), 'utf8')) as Task;
                } catch (e) {
                    return null;
                }
            })
            .filter((t): t is Task => t !== null && (t.status === 'in_progress' || t.status === 'pending'));
    }
}
