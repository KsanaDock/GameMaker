import * as fs from 'fs/promises';
import * as path from 'path';
import { getBlockedGameArtifactReason } from './game-file-guard.js';

export function registerFileTools(registry: any, projectRoot: string) {
    // 1. list_dir
    registry.register({
        name: 'list_dir',
        description: 'List contents of a directory',
        parameters: {
            type: 'object',
            properties: {
                directory: { type: 'string', description: 'Directory path relative to project root' },
                recursive: { type: 'boolean', description: 'Whether to list subdirectories' }
            },
            required: ['directory']
        },
        handler: async (args: any) => {
            const fullPath = path.resolve(projectRoot, args.directory);
            if (!fullPath.startsWith(projectRoot)) {
                return { error: 'Permission denied: path outside project root' };
            }
            try {
                const entries = await fs.readdir(fullPath, { withFileTypes: true, recursive: args.recursive || false });
                return entries
                    .filter(e => {
                        const name = e.name;
                        // Ignore noisy folders if we're listing the root or recursively
                        if (name === 'addons' || name === '.godot' || name === '.git') {
                            return false;
                        }
                        return true;
                    })
                    .map(e => ({
                        name: e.name,
                        path: path.relative(projectRoot, path.join((e as any).path || '', e.name)),
                        isDirectory: e.isDirectory()
                    }));
            } catch (e: any) {
                return { error: e.message };
            }
        }
    });

    // 2. read_file
    registry.register({
        name: 'read_file',
        description: 'Read a file content',
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'File path relative to project root' }
            },
            required: ['filePath']
        },
        handler: async (args: any) => {
            const fullPath = path.resolve(projectRoot, args.filePath);
            if (!fullPath.startsWith(projectRoot)) {
                return { error: 'Permission denied: path outside project root' };
            }
            try {
                const content = await fs.readFile(fullPath, 'utf-8');
                return { content };
            } catch (e: any) {
                return { error: e.message };
            }
        }
    });

    // 3. write_file
    registry.register({
        name: 'write_file',
        description: 'Write/Create a file',
        parameters: {
            type: 'object',
            properties: {
                filePath: { type: 'string', description: 'File path relative to project root' },
                content: { type: 'string', description: 'New file content' }
            },
            required: ['filePath', 'content']
        },
        handler: async (args: any) => {
            const blockedReason = getBlockedGameArtifactReason(args.filePath || '');
            if (blockedReason) {
                return { error: blockedReason };
            }

            const fullPath = path.resolve(projectRoot, args.filePath);
            if (!fullPath.startsWith(projectRoot)) {
                return { error: 'Permission denied: path outside project root' };
            }
            try {
                await fs.mkdir(path.dirname(fullPath), { recursive: true });
                await fs.writeFile(fullPath, args.content, 'utf-8');
                return { status: 'ok' };
            } catch (e: any) {
                return { error: e.message };
            }
        }
    });

    // 4. grep_search (Claude Code style)
    registry.register({
        name: 'grep_search',
        description: `A powerful search tool.
Usage:
- ALWAYS use grep_search for search tasks.
- Supports regex syntax.
- Filter files with 'include_glob' (e.g. "*.js", "**/*.ts").
- 'output_mode' can be 'content' (shows lines with numbers), 'files_with_matches', or 'count'.`,
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'String or regex pattern to search for' },
                directory: { type: 'string', description: 'Directory to search relative to project root. Defaults to root.' },
                include_glob: { type: 'string', description: 'Glob pattern to filter files. Example: *.ts' },
                output_mode: { 
                    type: 'string', 
                    description: 'content, files_with_matches, or count', 
                    enum: ['content', 'files_with_matches', 'count'] 
                }
            },
            required: ['pattern']
        },
        handler: async (args: any) => {
            const { pattern, directory = './', include_glob, output_mode = 'files_with_matches' } = args;
            const fullPath = path.resolve(projectRoot, directory);
            if (!fullPath.startsWith(projectRoot)) {
                return { error: 'Permission denied: path outside project root' };
            }

            const results: any[] = [];
            const regex = new RegExp(pattern, 'i');
            
            // Simple file extension matcher based on glob (e.g., *.ts -> .ts)
            // A production environment would use 'minimatch' or 'glob' library.
            let extMatch = '';
            if (include_glob && include_glob.startsWith('*.')) {
                extMatch = include_glob.substring(1);
            }

            let totalMatches = 0;
            let fileCount = 0;

            async function walk(dir: string) {
                let files;
                try {
                    files = await fs.readdir(dir, { withFileTypes: true });
                } catch { return; } // Skip inaccessible

                for (const file of files) {
                    const fullPath = path.join(dir, file.name);
                    
                    // Exclude heavy/noisy folders like .git, Godot `.godot` caching
                    if (file.isDirectory() && !file.name.startsWith('.') && file.name !== 'node_modules' && file.name !== 'addons') {
                        await walk(fullPath);
                    } else if (file.isFile()) {
                        if (extMatch && !file.name.endsWith(extMatch)) continue;

                        try {
                            const content = await fs.readFile(fullPath, 'utf-8');
                            const lines = content.split('\n');
                            const matchLines: any[] = [];
                            
                            for (let i = 0; i < lines.length; i++) {
                                const line = lines[i];
                                if (line !== undefined && regex.test(line)) {
                                    matchLines.push({ line: i + 1, text: line.trim() });
                                    totalMatches++;
                                }
                            }

                            if (matchLines.length > 0) {
                                fileCount++;
                                if (output_mode === 'content') {
                                    results.push({
                                        file: path.relative(projectRoot, fullPath),
                                        matches: matchLines
                                    });
                                } else if (output_mode === 'files_with_matches') {
                                    results.push(path.relative(projectRoot, fullPath));
                                }
                            }
                        } catch (e) {
                            // Suppress binary or unreadable file errors
                        }
                    }
                }
            }
            
            try {
                await walk(fullPath);
                
                if (output_mode === 'count') {
                    return `Found ${totalMatches} occurrences across ${fileCount} files.`;
                } else if (output_mode === 'files_with_matches') {
                    return `Found ${fileCount} files:\n${results.join('\\n')}`;
                } else {
                    // Content format
                    let output = '';
                    for (const r of results) {
                        output += `\n[File: ${r.file}]\n`;
                        for (const m of r.matches) {
                            output += `${m.line}: ${m.text}\n`;
                        }
                    }
                    return output || 'No matches found.';
                }
            } catch (e: any) {
                return { error: e.message };
            }
        }
    });
}
