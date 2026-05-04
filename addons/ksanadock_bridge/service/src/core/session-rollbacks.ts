import { createCheckpoint, listCheckpoints, getCheckpoint, restoreCheckpoint } from '../tools/checkpoint-tools.js';

export class SessionRollbackManager {
    private projectRoot: string;
    private messageIndex = 0;
    private sessionId = 'current';

    constructor(projectRoot: string) {
        this.projectRoot = projectRoot;
    }

    public setSession(sessionId: string) {
        this.sessionId = normalizeSessionId(sessionId);
        this.messageIndex = 0;
    }

    public async initialize() {
        const list = await this.listCurrentSessionCheckpoints();
        const indexes = Array.isArray(list.checkpoints)
            ? list.checkpoints
                .map((checkpoint: any) => Number(checkpoint.messageIndex))
                .filter((value: number) => Number.isFinite(value))
            : [];
        this.messageIndex = indexes.length > 0 ? Math.max(...indexes) + 1 : 0;
    }

    public async beforeUserMessage(label: string = 'Before user message') {
        const messageIndex = this.messageIndex;
        const checkpoint = await createCheckpoint(this.projectRoot, {
            label,
            session_id: this.sessionId,
            message_index: messageIndex,
            trigger: 'user_message'
        });
        this.messageIndex += 1;
        return {
            ...checkpoint,
            messageIndex
        };
    }

    public async listCurrentSessionCheckpoints() {
        return listCheckpoints(this.projectRoot, { session_id: this.sessionId });
    }

    public async getCheckpoint(checkpointId: string) {
        return getCheckpoint(this.projectRoot, { checkpoint_id: checkpointId });
    }

    public async restoreCheckpoint(checkpointId: string, files?: string[]) {
        return restoreCheckpoint(this.projectRoot, {
            checkpoint_id: checkpointId,
            files
        });
    }
}

function normalizeSessionId(input: string): string {
    return String(input || 'current').replace(/[^a-zA-Z0-9_-]/g, '') || 'current';
}
