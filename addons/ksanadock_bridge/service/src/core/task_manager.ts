import * as fs from 'fs';
import * as path from 'path';
import type { Task, TaskStatus } from '../types/index.js';
import { ensureKsanadockDirSync } from './project-data.js';

export class TaskManager {
    private dir: string;
    private nextId: number = 1;

    constructor(projectRoot: string) {
        const ksanadockDir = ensureKsanadockDirSync(projectRoot);
        this.dir = path.join(ksanadockDir, 'tasks');
        if (!fs.existsSync(this.dir)) {
            fs.mkdirSync(this.dir, { recursive: true });
        }
        this.nextId = this.getMaxId() + 1;
    }

    private getMaxId(): number {
        const files = fs.readdirSync(this.dir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        if (files.length === 0) return 0;
        const ids = files.map(f => parseInt(f.replace('task_', '').replace('.json', ''), 10));
        return Math.max(...ids);
    }

    private save(task: Task) {
        const p = path.join(this.dir, `task_${task.id}.json`);
        // Ensure atomic save by writing to temp then rename, or just simple write (for this implementation, sync write is okay)
        fs.writeFileSync(p, JSON.stringify(task, null, 2), 'utf8');
    }

    private load(id: number): Task {
        const p = path.join(this.dir, `task_${id}.json`);
        if (!fs.existsSync(p)) throw new Error(`Task ${id} not found.`);
        return JSON.parse(fs.readFileSync(p, 'utf8'));
    }

    public create(subject: string, description: string = ''): string {
        const task: Task = {
            id: this.nextId++,
            subject,
            description,
            status: 'pending',
            blockedBy: []
        };
        this.save(task);
        return JSON.stringify(task, null, 2);
    }

    private clearDependency(completedId: number) {
        const files = fs.readdirSync(this.dir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        for (const file of files) {
            const task = JSON.parse(fs.readFileSync(path.join(this.dir, file), 'utf8')) as Task;
            if (task.blockedBy.includes(completedId)) {
                task.blockedBy = task.blockedBy.filter(id => id !== completedId);
                this.save(task);
            }
        }
    }

    public update(taskId: number, status?: TaskStatus, addBlockedBy?: number[], removeBlockedBy?: number[]): string {
        const task = this.load(taskId);
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
        this.save(task);
        return JSON.stringify(task, null, 2);
    }

    public listAll(): string {
        if (!fs.existsSync(this.dir)) return "[]";
        const files = fs.readdirSync(this.dir).filter(f => f.startsWith('task_') && f.endsWith('.json'));
        const tasks = files.map(f => JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8')) as Task);
        return JSON.stringify(tasks, null, 2);
    }

    public get(taskId: number): string {
        return JSON.stringify(this.load(taskId), null, 2);
    }
}
