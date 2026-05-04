import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import type { ToolRegistry } from './tool-registry.js';
import { ensureKsanadockDir } from '../core/project-data.js';

const execAsync = promisify(exec);

const DEFAULT_TIMEOUT_MS = 120000;
const MAX_TIMEOUT_MS = 600000;
const DEFAULT_MAX_OUTPUT_CHARS = 20000;
const MAX_OUTPUT_CHARS = 80000;

export function registerShellTools(registry: ToolRegistry, projectRoot: string) {
    const handler = async (args: any) => runShellCommand(projectRoot, args);

    for (const name of ['shell', 'terminal', 'exec']) {
        registry.register({
            name,
            description: `Run a terminal command inside the project workspace.
Use this for validation, Godot headless checks, git inspection, build commands, formatters, and scripted file operations.
The working directory must stay inside the project root. Dangerous system-level destructive commands are blocked.
Prefer project-local checks first, and keep commands non-interactive.`,
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'Command to run. Keep it non-interactive.' },
                    cwd: { type: 'string', description: 'Working directory relative to project root. Defaults to project root.' },
                    timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 120000, max 600000.' },
                    max_output_chars: { type: 'number', description: 'Maximum stdout/stderr characters returned. Default 20000, max 80000.' }
                },
                required: ['command']
            },
            handler
        });
    }
}

async function runShellCommand(projectRoot: string, args: any) {
    const command = String(args.command || '').trim();
    if (!command) {
        return { error: 'Command is required.' };
    }

    const blockedReason = getBlockedCommandReason(command);
    if (blockedReason) {
        return { error: blockedReason };
    }

    const cwd = resolveInsideProject(projectRoot, String(args.cwd || '.'));
    if (!cwd) {
        return { error: 'Permission denied: cwd must be inside project root.' };
    }

    const timeout = clampNumber(args.timeout_ms, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    const maxOutputChars = clampNumber(args.max_output_chars, DEFAULT_MAX_OUTPUT_CHARS, 1000, MAX_OUTPUT_CHARS);
    const startedAt = new Date();

    try {
        const { stdout, stderr } = await execAsync(command, {
            cwd,
            timeout,
            maxBuffer: Math.max(maxOutputChars * 4, 1024 * 1024),
            windowsHide: true,
            env: {
                ...process.env,
                FORCE_COLOR: '0',
                NO_COLOR: '1'
            }
        });

        const result = {
            status: 'ok',
            exit_code: 0,
            cwd: toProjectRelative(projectRoot, cwd),
            command,
            duration_ms: Date.now() - startedAt.getTime(),
            stdout: truncate(stdout, maxOutputChars),
            stderr: truncate(stderr, maxOutputChars)
        };
        await appendShellAudit(projectRoot, result);
        return result;
    } catch (err: any) {
        const result = {
            status: 'error',
            exit_code: typeof err.code === 'number' ? err.code : null,
            signal: err.signal || null,
            timed_out: Boolean(err.killed),
            cwd: toProjectRelative(projectRoot, cwd),
            command,
            duration_ms: Date.now() - startedAt.getTime(),
            stdout: truncate(String(err.stdout || ''), maxOutputChars),
            stderr: truncate(String(err.stderr || err.message || ''), maxOutputChars)
        };
        await appendShellAudit(projectRoot, result);
        return result;
    }
}

function getBlockedCommandReason(command: string): string | null {
    const normalized = command.toLowerCase().replace(/\s+/g, ' ').trim();
    const blockedPatterns = [
        /\brm\s+-rf\s+(\/|~|\*)/,
        /\bsudo\b/,
        /\bformat\s+[a-z]:/i,
        /\bdiskpart\b/,
        /\bshutdown\b/,
        /\brestart-computer\b/,
        /\bstop-computer\b/,
        /\bdel\s+\/[fsq]+\s+[a-z]:\\/i,
        /\brmdir\s+\/[sq]+\s+[a-z]:\\/i,
        /\bremove-item\b.*\b-recurse\b.*\b(force|-force)\b.*([a-z]:\\|~|\/)/i,
        /\bgit\s+reset\s+--hard\b/,
        /\bgit\s+clean\b.*\b-f\b/
    ];

    if (blockedPatterns.some(pattern => pattern.test(normalized))) {
        return 'Blocked potentially destructive system-level command. Use checkpoint_restore for project rollback, or run narrower project-local commands.';
    }

    return null;
}

function resolveInsideProject(projectRoot: string, relativePath: string): string | null {
    const root = path.resolve(projectRoot);
    const target = path.resolve(root, relativePath || '.');
    return isInside(root, target) ? target : null;
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function toProjectRelative(projectRoot: string, fullPath: string): string {
    const rel = path.relative(path.resolve(projectRoot), path.resolve(fullPath)).replace(/\\/g, '/');
    return rel || '.';
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}

function truncate(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, maxChars)}\n...[truncated ${value.length - maxChars} chars]`;
}

async function appendShellAudit(projectRoot: string, result: Record<string, any>): Promise<void> {
    try {
        const ksanadockDir = await ensureKsanadockDir(projectRoot);
        const auditDir = path.join(ksanadockDir, 'shell');
        await fs.mkdir(auditDir, { recursive: true });
        const auditPath = path.join(auditDir, 'commands.jsonl');
        const auditEntry = {
            timestamp: new Date().toISOString(),
            command: result.command,
            cwd: result.cwd,
            status: result.status,
            exit_code: result.exit_code,
            signal: result.signal,
            timed_out: result.timed_out,
            duration_ms: result.duration_ms
        };
        await fs.appendFile(auditPath, `${JSON.stringify(auditEntry)}\n`, 'utf-8');
    } catch {
        // Shell execution results should not fail just because audit persistence failed.
    }
}
