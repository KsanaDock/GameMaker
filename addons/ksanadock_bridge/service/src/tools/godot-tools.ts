import { exec, execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import type { ToolRegistry } from './tool-registry.js';
import { ensureKsanadockDir } from '../core/project-data.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const GODOT_CONFIG_FILE = 'godot-config.json';
const DEFAULT_TIMEOUT_MS = 60000;

interface GodotConfig {
    executablePath: string;
    version: string;
    discoveredAt: string;
}

interface ParsedError {
    file: string;
    line: number | null;
    type: string;
    message: string;
}

interface GodotResult {
    ok: boolean;
    errors: ParsedError[];
    raw_output: string;
    duration_ms: number;
    error?: string;
}

// ── Discovery ────────────────────────────────────────────────────────────────

async function probeExecutable(exePath: string): Promise<string | null> {
    try {
        const { stdout } = await execFileAsync(exePath, ['--version'], { timeout: 8000 });
        const version = (stdout || '').trim().split('\n')[0]?.trim() ?? '';
        return version || 'unknown';
    } catch {
        return null;
    }
}

async function scanDir(dir: string, pattern: RegExp): Promise<string[]> {
    try {
        const entries = await fs.readdir(dir);
        return entries
            .filter(e => pattern.test(e))
            .map(e => path.join(dir, e));
    } catch {
        return [];
    }
}

async function discoverGodotExecutable(): Promise<{ exePath: string; version: string; source: string } | null> {
    // 1. Environment variable override
    const envPath = process.env.GODOT_EXECUTABLE;
    if (envPath) {
        const version = await probeExecutable(envPath);
        if (version) return { exePath: envPath, version, source: 'GODOT_EXECUTABLE env var' };    }

    // 2. PATH probe
    for (const cmd of ['godot', 'godot4']) {
        try {
            const { stdout } = await execAsync(`${cmd} --version`, { timeout: 8000 });
            const version = (stdout || '').trim().split('\n')[0]?.trim() ?? '';
            if (version) return { exePath: cmd, version, source: `PATH (${cmd})` };
        } catch { /* not in PATH */ }
    }

    const platform = os.platform();

    if (platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const userProfile = process.env.USERPROFILE || os.homedir();
        const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
        const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';

        const searchDirs: Array<{ dir: string; pattern: RegExp }> = [
            { dir: path.join(localAppData, 'Programs', 'Godot'), pattern: /^Godot_v4.*\.exe$/i },
            { dir: path.join(programFiles, 'Godot'), pattern: /^Godot_v4.*\.exe$/i },
            { dir: path.join(programFilesX86, 'Godot'), pattern: /^Godot_v4.*\.exe$/i },
            { dir: path.join(userProfile, 'scoop', 'apps', 'godot', 'current'), pattern: /^godot.*\.exe$/i },
            { dir: 'C:\\ProgramData\\chocolatey\\bin', pattern: /^godot.*\.exe$/i },
        ];

        for (const { dir, pattern } of searchDirs) {
            const candidates = await scanDir(dir, pattern);
            // Prefer the highest version by sorting descending
            candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const candidate of candidates) {
                const version = await probeExecutable(candidate);
                if (version) return { exePath: candidate, version, source: `auto-discovered (${dir})` };
            }
        }

        // Also check common flat install paths like C:\Godot\Godot_v4.x.exe
        const flatDirs = ['C:\\Godot', path.join(userProfile, 'Godot')];
        for (const dir of flatDirs) {
            const candidates = await scanDir(dir, /^Godot_v4.*\.exe$/i);
            candidates.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
            for (const candidate of candidates) {
                const version = await probeExecutable(candidate);
                if (version) return { exePath: candidate, version, source: `auto-discovered (${dir})` };
            }
        }
    } else if (platform === 'darwin') {
        const macCandidates = [
            '/Applications/Godot.app/Contents/MacOS/Godot',
            '/opt/homebrew/bin/godot4',
            '/opt/homebrew/bin/godot',
            '/usr/local/bin/godot4',
            '/usr/local/bin/godot',
        ];
        // Also scan /Applications for versioned Godot_v4*.app
        const appDirEntries = await scanDir('/Applications', /^Godot_v4.*\.app$/i);
        for (const appDir of appDirEntries) {
            macCandidates.unshift(path.join(appDir, 'Contents', 'MacOS', 'Godot'));
        }
        for (const candidate of macCandidates) {
            const version = await probeExecutable(candidate);
            if (version) return { exePath: candidate, version, source: `auto-discovered (${candidate})` };
        }
    } else {
        // Linux
        const linuxCandidates = [
            '/usr/bin/godot4',
            '/usr/local/bin/godot4',
            '/usr/bin/godot',
            '/usr/local/bin/godot',
            path.join(os.homedir(), '.local', 'bin', 'godot4'),
            path.join(os.homedir(), '.local', 'bin', 'godot'),
        ];
        for (const candidate of linuxCandidates) {
            const version = await probeExecutable(candidate);
            if (version) return { exePath: candidate, version, source: `auto-discovered (${candidate})` };
        }
    }

    return null;
}

// ── Config cache ─────────────────────────────────────────────────────────────

async function loadCachedConfig(projectRoot: string): Promise<GodotConfig | null> {
    try {
        const ksanadockDir = await ensureKsanadockDir(projectRoot);
        const configPath = path.join(ksanadockDir, GODOT_CONFIG_FILE);
        const raw = await fs.readFile(configPath, 'utf-8');
        return JSON.parse(raw) as GodotConfig;
    } catch {
        return null;
    }
}

async function saveCachedConfig(projectRoot: string, config: GodotConfig): Promise<void> {
    try {
        const ksanadockDir = await ensureKsanadockDir(projectRoot);
        const configPath = path.join(ksanadockDir, GODOT_CONFIG_FILE);
        await fs.writeFile(configPath, JSON.stringify(config, null, 2), 'utf-8');
    } catch { /* non-fatal */ }
}

async function resolveGodotExecutable(projectRoot: string): Promise<{ exePath: string; version: string; source: string } | null> {
    // Check cache first
    const cached = await loadCachedConfig(projectRoot);
    if (cached?.executablePath) {
        const version = await probeExecutable(cached.executablePath);
        if (version) return { exePath: cached.executablePath, version, source: 'cached config' };
        // Cache is stale — fall through to re-discover
    }

    const found = await discoverGodotExecutable();
    if (found) {
        await saveCachedConfig(projectRoot, {
            executablePath: found.exePath,
            version: found.version,
            discoveredAt: new Date().toISOString(),
        });
    }
    return found;
}

// ── Error parsing ─────────────────────────────────────────────────────────────

function parseGodotOutput(output: string): ParsedError[] {
    const errors: ParsedError[] = [];
    const lines = output.split('\n');

    // Patterns:
    // "SCRIPT ERROR: Parse Error: ..."  followed by "   at: GDScript (res://path.gd:42)"
    // "ERROR: res://path.gd:42 - ..."
    // "SCRIPT ERROR: Cannot infer ..."  followed by "   at: GDScript (res://path.gd:15)"

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? '';

        // Pattern 1: SCRIPT ERROR / ERROR with "at:" on next line
        const scriptErrMatch = line.match(/^(?:SCRIPT )?ERROR:\s*(.+)$/);
        if (scriptErrMatch) {
            const message = (scriptErrMatch[1] ?? '').trim();
            let file = '';
            let lineNum: number | null = null;
            let type = 'Error';

            // Check if next line has "at: GDScript (res://...)"
            const nextLine = lines[i + 1] ?? '';
            const atMatch = nextLine.match(/at:\s*GDScript\s*\(res:\/\/([^:)]+):?(\d+)?\)/);
            if (atMatch) {
                file = atMatch[1] ?? '';
                lineNum = atMatch[2] ? parseInt(atMatch[2], 10) : null;
                i++; // consume the "at:" line
            }

            // Extract type from message prefix (e.g. "Parse Error: ...")
            const typeMatch = message.match(/^([A-Za-z ]+Error):\s*(.+)$/);
            if (typeMatch) {
                type = typeMatch[1] ?? 'Error';
            }

            // Pattern: "res://path.gd:42 - message" embedded in the error line
            const inlineFileMatch = message.match(/^res:\/\/([^:]+):(\d+)\s*-\s*(.+)$/);
            if (inlineFileMatch) {
                file = inlineFileMatch[1] ?? '';
                lineNum = parseInt(inlineFileMatch[2] ?? '0', 10);
            }

            if (message && !message.startsWith('Condition')) {
                errors.push({ file, line: lineNum, type, message });
            }
            continue;
        }

        // Pattern 2: "Parse Error at res://path.gd:42"
        const parseErrMatch = line.match(/Parse Error.*?res:\/\/([^:]+):(\d+)/);
        if (parseErrMatch) {
            errors.push({
                file: parseErrMatch[1] ?? '',
                line: parseInt(parseErrMatch[2] ?? '0', 10),
                type: 'Parse Error',
                message: line.trim(),
            });
        }
    }

    return errors;
}

// ── Tool runner ───────────────────────────────────────────────────────────────

async function runGodotCommand(
    exePath: string,
    args: string[],
    cwd: string,
    timeoutMs: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
        const { stdout, stderr } = await execFileAsync(exePath, args, {
            cwd,
            timeout: timeoutMs,
            maxBuffer: 10 * 1024 * 1024,
            env: { ...process.env, DISPLAY: process.env.DISPLAY || ':0' },
        });
        return { stdout: stdout || '', stderr: stderr || '', exitCode: 0 };
    } catch (err: any) {
        return {
            stdout: String(err.stdout || ''),
            stderr: String(err.stderr || err.message || ''),
            exitCode: typeof err.code === 'number' ? err.code : 1,
        };
    }
}

// ── Tool registration ─────────────────────────────────────────────────────────

export function registerGodotTools(registry: ToolRegistry, projectRoot: string) {
    registry.register({
        name: 'godot_find_executable',
        description: 'Locate the Godot 4 executable on this machine. Returns the resolved path, version string, and how it was found. Call this first if other godot_* tools fail.',
        parameters: {
            type: 'object',
            properties: {},
            required: [],
        },
        handler: async (_args: any) => {
            const found = await resolveGodotExecutable(projectRoot);
            if (!found) {
                return {
                    ok: false,
                    path: null,
                    version: null,
                    source: null,
                    error: 'Godot 4 executable not found. Install Godot 4 or set GODOT_EXECUTABLE in .env to the full path of the executable.',
                };
            }
            return { ok: true, path: found.exePath, version: found.version, source: found.source };
        },
    });

    registry.register({
        name: 'godot_import',
        description: 'Run `godot --headless --import` to generate .import files for new or modified assets (textures, GLBs, audio). Must be run before scene builders that use load() on those assets.',
        parameters: {
            type: 'object',
            properties: {
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 60000.' },
            },
            required: [],
        },
        handler: async (args: any) => {
            const startedAt = Date.now();
            const found = await resolveGodotExecutable(projectRoot);
            if (!found) {
                return {
                    ok: false,
                    errors: [],
                    raw_output: '',
                    duration_ms: Date.now() - startedAt,
                    error: 'Godot 4 executable not found. Install Godot 4 or set GODOT_EXECUTABLE in .env.',
                };
            }

            const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
            const { stdout, stderr } = await runGodotCommand(
                found.exePath,
                ['--headless', '--import'],
                projectRoot,
                timeout
            );

            const raw_output = [stdout, stderr].filter(Boolean).join('\n').trim();
            const errors = parseGodotOutput(raw_output);
            const result: GodotResult = {
                ok: errors.length === 0,
                errors,
                raw_output,
                duration_ms: Date.now() - startedAt,
            };
            return result;
        },
    });

    registry.register({
        name: 'godot_run_script',
        description: 'Run `godot --headless --script <path>` to execute a GDScript scene builder (extends SceneTree). The script must call quit() when done. Returns stdout/stderr and any parse errors.',
        parameters: {
            type: 'object',
            properties: {
                script_path: {
                    type: 'string',
                    description: 'Path to the scene builder script, relative to project root (e.g. "scripts/builders/build_player.gd").',
                },
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 60000.' },
            },
            required: ['script_path'],
        },
        handler: async (args: any) => {
            const startedAt = Date.now();
            const found = await resolveGodotExecutable(projectRoot);
            if (!found) {
                return {
                    ok: false,
                    errors: [],
                    raw_output: '',
                    duration_ms: Date.now() - startedAt,
                    error: 'Godot 4 executable not found. Install Godot 4 or set GODOT_EXECUTABLE in .env.',
                };
            }

            const scriptPath = String(args.script_path || '').trim();
            if (!scriptPath) {
                return { ok: false, errors: [], raw_output: '', duration_ms: 0, error: 'script_path is required.' };
            }

            const absScript = path.isAbsolute(scriptPath)
                ? scriptPath
                : path.resolve(projectRoot, scriptPath);

            const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
            const { stdout, stderr, exitCode } = await runGodotCommand(
                found.exePath,
                ['--headless', '--script', absScript],
                projectRoot,
                timeout
            );

            const raw_output = [stdout, stderr].filter(Boolean).join('\n').trim();
            const errors = parseGodotOutput(raw_output);
            const result: GodotResult = {
                ok: exitCode === 0 && errors.length === 0,
                errors,
                raw_output,
                duration_ms: Date.now() - startedAt,
            };
            return result;
        },
    });

    registry.register({
        name: 'godot_validate',
        description: 'Run `godot --headless --quit` to parse-check all GDScript files in the project. This is the primary quality gate — call it after writing or modifying any .gd file. Returns structured errors with file paths and line numbers.',
        parameters: {
            type: 'object',
            properties: {
                timeout_ms: { type: 'number', description: 'Timeout in milliseconds. Default 60000.' },
            },
            required: [],
        },
        handler: async (args: any) => {
            const startedAt = Date.now();
            const found = await resolveGodotExecutable(projectRoot);
            if (!found) {
                return {
                    ok: false,
                    errors: [],
                    raw_output: '',
                    duration_ms: Date.now() - startedAt,
                    error: 'Godot 4 executable not found. Install Godot 4 or set GODOT_EXECUTABLE in .env.',
                };
            }

            const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : DEFAULT_TIMEOUT_MS;
            const { stdout, stderr } = await runGodotCommand(
                found.exePath,
                ['--headless', '--quit'],
                projectRoot,
                timeout
            );

            const raw_output = [stdout, stderr].filter(Boolean).join('\n').trim();
            const errors = parseGodotOutput(raw_output);
            const result: GodotResult = {
                ok: errors.length === 0,
                errors,
                raw_output,
                duration_ms: Date.now() - startedAt,
            };
            return result;
        },
    });
}
