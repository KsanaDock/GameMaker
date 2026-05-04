import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ToolRegistry } from './tool-registry.js';
import { ensureKsanadockDir } from '../core/project-data.js';
import { getBlockedGameArtifactReason } from './game-file-guard.js';

interface CheckpointManifest {
    id: string;
    createdAt: string;
    label: string;
    sessionId?: string;
    messageIndex?: number;
    trigger?: string;
    files: Array<{
        path: string;
        size: number;
        existed: boolean;
        sha256?: string;
    }>;
}

const DEFAULT_INCLUDE_GLOBS = [
    '**/*.gd',
    '**/*.ts',
    '**/*.js',
    '**/*.json',
    '**/*.tscn',
    '**/*.tres',
    'project.godot',
    'README*.md'
];

const SKIPPED_DIRS = new Set(['.git', '.godot', 'node_modules']);

export function registerCheckpointTools(registry: ToolRegistry, projectRoot: string) {
    registry.register({
        name: 'checkpoint_create',
        description: `Create a rollback checkpoint for project files.
Use this before risky multi-file edits or before starting a user-visible phase. The checkpoint can later be restored by checkpoint_restore.`,
        parameters: {
            type: 'object',
            properties: {
                label: { type: 'string', description: 'Human-readable checkpoint label.' },
                files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional explicit file paths relative to project root. If omitted, snapshots common code/resource files.'
                },
                session_id: { type: 'string', description: 'Optional session id to bind this checkpoint to. Defaults to current.' },
                message_index: { type: 'number', description: 'Optional conversation message index associated with this checkpoint.' },
                trigger: { type: 'string', description: 'Optional source of checkpoint creation, e.g. user_message or manual.' }
            },
            required: []
        },
        handler: async (args: any) => createCheckpoint(projectRoot, args)
    });

    registry.register({
        name: 'checkpoint_list',
        description: 'List available project rollback checkpoints.',
        parameters: {
            type: 'object',
            properties: {
                session_id: { type: 'string', description: 'Optional session id filter. Use current for the active chat session.' }
            },
            required: []
        },
        handler: async (args: any) => listCheckpoints(projectRoot, args)
    });

    registry.register({
        name: 'checkpoint_get',
        description: 'Get checkpoint details and compare captured files with the current workspace state.',
        parameters: {
            type: 'object',
            properties: {
                checkpoint_id: { type: 'string', description: 'Checkpoint id returned by checkpoint_create or checkpoint_list.' },
                include_files: { type: 'boolean', description: 'Whether to include file-level details. Defaults to true.' }
            },
            required: ['checkpoint_id']
        },
        handler: async (args: any) => getCheckpoint(projectRoot, args)
    });

    registry.register({
        name: 'checkpoint_restore',
        description: `Restore files from a previous checkpoint.
Use this to roll back a coding session or a risky edit. If files is omitted, all files captured in the checkpoint are restored.`,
        parameters: {
            type: 'object',
            properties: {
                checkpoint_id: { type: 'string', description: 'Checkpoint id returned by checkpoint_create or checkpoint_list.' },
                files: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional subset of files to restore.'
                }
            },
            required: ['checkpoint_id']
        },
        handler: async (args: any) => restoreCheckpoint(projectRoot, args)
    });
}

export async function createCheckpoint(projectRoot: string, args: any) {
    const checkpointsRoot = await getCheckpointsRoot(projectRoot);
    const id = `${new Date().toISOString().replace(/[-:.]/g, '').replace('T', '-').replace('Z', '')}-${randomSuffix()}`;
    const checkpointDir = path.join(checkpointsRoot, id);
    const filesDir = path.join(checkpointDir, 'files');
    await fs.mkdir(filesDir, { recursive: true });

    const files = Array.isArray(args.files) && args.files.length > 0
        ? normalizeExplicitFiles(projectRoot, args.files)
        : await discoverCheckpointFiles(projectRoot);

    const manifest: CheckpointManifest = {
        id,
        createdAt: new Date().toISOString(),
        label: String(args.label || 'Agent checkpoint').trim() || 'Agent checkpoint',
        sessionId: normalizeSessionId(args.session_id || args.sessionId || 'current'),
        trigger: String(args.trigger || 'manual'),
        files: []
    };
    if (Number.isFinite(Number(args.message_index))) {
        manifest.messageIndex = Number(args.message_index);
    }

    for (const relPath of files) {
        const fullPath = path.resolve(projectRoot, relPath);
        if (!isInside(projectRoot, fullPath)) continue;
        try {
            const stat = await fs.stat(fullPath);
            if (!stat.isFile()) continue;
            const target = path.join(filesDir, relPath);
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(fullPath, target);
            manifest.files.push({
                path: relPath,
                size: stat.size,
                existed: true,
                sha256: await sha256File(fullPath)
            });
        } catch {
            manifest.files.push({ path: relPath, size: 0, existed: false });
        }
    }

    await fs.writeFile(path.join(checkpointDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');
    return {
        status: 'ok',
        checkpoint_id: id,
        label: manifest.label,
        file_count: manifest.files.length,
        path: toProjectRelative(projectRoot, checkpointDir)
    };
}

export async function listCheckpoints(projectRoot: string, args: any = {}) {
    const checkpointsRoot = await getCheckpointsRoot(projectRoot);
    let entries: string[] = [];
    try {
        entries = await fs.readdir(checkpointsRoot);
    } catch {
        return { checkpoints: [] };
    }

    const checkpoints: CheckpointManifest[] = [];
    const sessionFilter = args.session_id ? normalizeSessionId(args.session_id) : '';
    for (const entry of entries) {
        try {
            const manifest = await readManifest(path.join(checkpointsRoot, entry));
            if (sessionFilter && normalizeSessionId(manifest.sessionId || '') !== sessionFilter) continue;
            checkpoints.push(manifest);
        } catch {
            // Ignore incomplete checkpoints.
        }
    }

    checkpoints.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return {
        checkpoints: checkpoints.map(checkpoint => ({
            id: checkpoint.id,
            createdAt: checkpoint.createdAt,
            label: checkpoint.label,
            sessionId: checkpoint.sessionId || '',
            messageIndex: checkpoint.messageIndex,
            trigger: checkpoint.trigger || '',
            file_count: checkpoint.files.length
        }))
    };
}

export async function getCheckpoint(projectRoot: string, args: any) {
    const checkpointsRoot = await getCheckpointsRoot(projectRoot);
    const checkpointId = sanitizeId(String(args.checkpoint_id || ''));
    if (!checkpointId) return { error: 'checkpoint_id is required.' };

    const checkpointDir = path.resolve(checkpointsRoot, checkpointId);
    if (!isInside(checkpointsRoot, checkpointDir)) {
        return { error: 'Invalid checkpoint_id.' };
    }

    const manifest = await readManifest(checkpointDir);
    const includeFiles = args.include_files !== false;
    const comparedFiles = await Promise.all(manifest.files.map(async file => {
        const currentPath = path.resolve(projectRoot, file.path);
        const current = await getCurrentFileState(currentPath);
        const status = compareFileState(file, current);
        return {
            ...file,
            current,
            status
        };
    }));

    const summary = comparedFiles.reduce((acc, item) => {
        acc[item.status] = (acc[item.status] || 0) + 1;
        return acc;
    }, {} as Record<string, number>);

    return {
        id: manifest.id,
        createdAt: manifest.createdAt,
        label: manifest.label,
        sessionId: manifest.sessionId || '',
        messageIndex: manifest.messageIndex,
        trigger: manifest.trigger || '',
        file_count: manifest.files.length,
        summary,
        files: includeFiles ? comparedFiles : undefined
    };
}

export async function restoreCheckpoint(projectRoot: string, args: any) {
    const checkpointsRoot = await getCheckpointsRoot(projectRoot);
    const checkpointId = sanitizeId(String(args.checkpoint_id || ''));
    if (!checkpointId) {
        return { error: 'checkpoint_id is required.' };
    }

    const checkpointDir = path.resolve(checkpointsRoot, checkpointId);
    if (!isInside(checkpointsRoot, checkpointDir)) {
        return { error: 'Invalid checkpoint_id.' };
    }

    const manifest = await readManifest(checkpointDir);
    const requestedFiles = Array.isArray(args.files) && args.files.length > 0
        ? new Set(normalizeExplicitFiles(projectRoot, args.files))
        : null;

    const restored: string[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const entry of manifest.files) {
        if (requestedFiles && !requestedFiles.has(entry.path)) continue;

        const blockedReason = getBlockedGameArtifactReason(entry.path);
        if (blockedReason) {
            skipped.push({ path: entry.path, reason: blockedReason });
            continue;
        }

        const target = path.resolve(projectRoot, entry.path);
        if (!isInside(projectRoot, target)) {
            skipped.push({ path: entry.path, reason: 'Target path is outside project root.' });
            continue;
        }

        if (!entry.existed) {
            try {
                await fs.rm(target, { force: true });
                restored.push(entry.path);
            } catch (err: any) {
                skipped.push({ path: entry.path, reason: err.message });
            }
            continue;
        }

        const source = path.join(checkpointDir, 'files', entry.path);
        try {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(source, target);
            restored.push(entry.path);
        } catch (err: any) {
            skipped.push({ path: entry.path, reason: err.message });
        }
    }

    return {
        status: 'ok',
        checkpoint_id: manifest.id,
        restored,
        skipped
    };
}

async function getCheckpointsRoot(projectRoot: string): Promise<string> {
    const ksanadockDir = await ensureKsanadockDir(projectRoot);
    const root = path.resolve(ksanadockDir, 'checkpoints');
    if (!isInside(projectRoot, root)) {
        throw new Error('Resolved checkpoints directory is outside the project root.');
    }
    await fs.mkdir(root, { recursive: true });
    return root;
}

async function getCurrentFileState(filePath: string): Promise<{ exists: boolean; size: number; sha256?: string }> {
    try {
        const stat = await fs.stat(filePath);
        if (!stat.isFile()) return { exists: false, size: 0 };
        return { exists: true, size: stat.size, sha256: await sha256File(filePath) };
    } catch {
        return { exists: false, size: 0 };
    }
}

function compareFileState(
    captured: CheckpointManifest['files'][number],
    current: { exists: boolean; size: number; sha256?: string }
): 'unchanged' | 'modified' | 'created_after_checkpoint' | 'deleted_after_checkpoint' | 'still_missing' {
    if (!captured.existed && !current.exists) return 'still_missing';
    if (!captured.existed && current.exists) return 'created_after_checkpoint';
    if (captured.existed && !current.exists) return 'deleted_after_checkpoint';
    return captured.sha256 === current.sha256 ? 'unchanged' : 'modified';
}

async function sha256File(filePath: string): Promise<string> {
    const buffer = await fs.readFile(filePath);
    return createHash('sha256').update(buffer).digest('hex');
}

async function readManifest(checkpointDir: string): Promise<CheckpointManifest> {
    const content = await fs.readFile(path.join(checkpointDir, 'manifest.json'), 'utf-8');
    return JSON.parse(content) as CheckpointManifest;
}

async function discoverCheckpointFiles(projectRoot: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(dir: string) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relPath = toProjectRelative(projectRoot, fullPath);
            if (entry.isDirectory()) {
                if (SKIPPED_DIRS.has(entry.name)) continue;
                if (relPath.startsWith('.ksanadock/checkpoints')) continue;
                await walk(fullPath);
            } else if (entry.isFile() && DEFAULT_INCLUDE_GLOBS.some(glob => matchesSimpleGlob(relPath, glob))) {
                files.push(relPath);
            }
        }
    }

    await walk(projectRoot);
    return files.sort();
}

function normalizeExplicitFiles(projectRoot: string, files: unknown[]): string[] {
    const normalized = new Set<string>();
    for (const file of files) {
        const rel = String(file || '').replace(/\\/g, '/').replace(/^res:\/\//, '').replace(/^\.\//, '');
        if (!rel) continue;
        const full = path.resolve(projectRoot, rel);
        if (isInside(projectRoot, full)) normalized.add(toProjectRelative(projectRoot, full));
    }
    return Array.from(normalized).sort();
}

function matchesSimpleGlob(filePath: string, glob: string): boolean {
    if (glob.startsWith('**/*.')) {
        return filePath.endsWith(glob.slice(4));
    }
    if (glob.endsWith('*.md')) {
        const prefix = glob.slice(0, -4);
        const fileName = path.basename(filePath);
        return fileName.startsWith(prefix);
    }
    return filePath === glob;
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function toProjectRelative(projectRoot: string, fullPath: string): string {
    return path.relative(path.resolve(projectRoot), path.resolve(fullPath)).replace(/\\/g, '/');
}

function randomSuffix(): string {
    return Math.random().toString(36).slice(2, 8);
}

function sanitizeId(input: string): string {
    return input.replace(/[^a-zA-Z0-9_-]/g, '');
}

function normalizeSessionId(input: string): string {
    return String(input || 'current').replace(/[^a-zA-Z0-9_-]/g, '') || 'current';
}
