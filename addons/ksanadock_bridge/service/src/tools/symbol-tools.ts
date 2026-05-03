import * as fs from 'fs';
import * as path from 'path';
import { ToolRegistry } from './tool-registry.js';

export function registerSymbolTools(registry: ToolRegistry, projectRoot: string) {
    registry.register({
        name: 'grep_symbols',
        description: 'Examine the codebase to find all class definitions, signals, and functions. Use this to map out the project architecture and understand available APIs before writing code.',
        parameters: {
            type: 'object',
            properties: {
                pattern: { type: 'string', description: 'Optional name of a class or function to search for. If empty, returns a high-level project map.' },
                include_files: { type: 'boolean', description: 'Whether to include the file paths in the output.' }
            },
            required: []
        },
        handler: async (args: any) => {
            const { pattern, include_files } = args;
            const symbols: any[] = [];
            
            // Simplified recursive scan for .gd files
            const walk = (dir: string) => {
                const files = fs.readdirSync(dir);
                for (const file of files) {
                    const fullPath = path.join(dir, file);
                    if (fs.statSync(fullPath).isDirectory()) {
                        if (file !== 'node_modules' && !file.startsWith('.') && file !== 'addons') {
                            walk(fullPath);
                        }
                    } else if (file.endsWith('.gd')) {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lines = content.split('\n');
                        
                        let className = "";
                        const fileSymbols: string[] = [];
                        
                        for (const line of lines) {
                            const trimmed = line.trim();
                            // Extract class_name
                            if (trimmed.startsWith('class_name ')) {
                                const parts = trimmed.split(' ');
                                if (parts.length > 1 && parts[1]) {
                                    className = parts[1];
                                    if (include_files) fileSymbols.push(`Class: ${className}`);
                                }
                            }
                            // Extract signals
                            if (trimmed.startsWith('signal ')) {
                                const parts = trimmed.split('signal ');
                                if (parts.length > 1) {
                                    const sigPart = parts[1];
                                    if (sigPart) {
                                        const sigName = sigPart.split('(')[0];
                                        if (sigName) fileSymbols.push(`  Signal: ${sigName}`);
                                    }
                                }
                            }
                            // Extract functions (excluding private ones if pattern exists, otherwise all)
                            if (trimmed.startsWith('func ')) {
                                const funcPart = trimmed.split('func ')[1];
                                if (funcPart) {
                                    const funcName = funcPart.split('(')[0];
                                    if (funcName && (!pattern || funcName.includes(pattern))) {
                                        fileSymbols.push(`  Func: ${funcName}`);
                                    }
                                }
                            }
                        }
                        
                        if (fileSymbols.length > 0) {
                            const relPath = path.relative(projectRoot, fullPath);
                            symbols.push({
                                path: relPath,
                                className: className,
                                symbols: fileSymbols
                            });
                        }
                    }
                }
            };
            
            try {
                walk(projectRoot);
                
                // Format output
                let output = "--- Project Symbol Map ---\n";
                for (const item of symbols) {
                    output += `\n[${item.path}]\n`;
                    if (item.className) output += `Class: ${item.className}\n`;
                    output += item.symbols.join('\n') + "\n";
                }
                
                return output || "No GDScript symbols found in project.";
            } catch (err: any) {
                return `Error indexing symbols: ${err.message}`;
            }
        }
    });

    registry.register({
        name: 'get_file_symbols',
        description: 'Get all symbols (classes, functions, signals, constants) defined in a specific GDScript file.',
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'Path to the .gd file relative to project root' }
            },
            required: ['file_path']
        },
        handler: async (args: any) => {
            const fullPath = path.join(projectRoot, args.file_path);
            if (!fs.existsSync(fullPath)) return `File not found: ${args.file_path}`;
            
            const content = fs.readFileSync(fullPath, 'utf8');
            const lines = content.split('\n');
            const result = [];
            
            for (const [i, rawLine] of lines.entries()) {
                const line = rawLine.trim();
                if (line.startsWith('class_name ') || line.startsWith('func ') || 
                    line.startsWith('signal ') || line.startsWith('const ') || line.startsWith('extends ')) {
                    result.push(`${i + 1}: ${line}`);
                }
            }
            return result.join('\n') || "No major symbols found in file.";
        }
    });

}
