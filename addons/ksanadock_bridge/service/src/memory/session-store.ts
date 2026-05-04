import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureKsanadockDirSync } from '../core/project-data.js';

export class SessionStore {
    private sessionPath: string;

    constructor(projectRoot: string) {
        const ksanadockDir = ensureKsanadockDirSync(projectRoot);
        this.sessionPath = path.join(ksanadockDir, 'sessions');
    }

    async saveSession(sessionId: string, history: any[]) {
        try {
            if (!this.sessionPath) return;
            await fs.mkdir(this.sessionPath, { recursive: true });
            
            const filePath = path.join(this.sessionPath, `${sessionId}.json`);
            
            // Clean history to ensure it's JSON serializable (strip any unexpected objects)
            const cleanHistory = history.map(m => ({
                role: m.role,
                content: m.content || "",
                tool_calls: m.tool_calls,
                tool_call_id: m.tool_call_id,
                name: m.name,
                checkpoint: m.checkpoint
            }));

            await fs.writeFile(filePath, JSON.stringify({
                sessionId,
                updatedAt: new Date().toISOString(),
                history: cleanHistory
            }));
        } catch (e) {
            // Silently fail as requested, but ensure the process doesn't crash
        }
    }

    async loadSession(sessionId: string): Promise<any[] | null> {
        try {
            const filePath = path.join(this.sessionPath, `${sessionId}.json`);
            const content = await fs.readFile(filePath, 'utf-8');
            const data = JSON.parse(content);
            return data.history;
        } catch (e) {
            return null;
        }
    }
}
