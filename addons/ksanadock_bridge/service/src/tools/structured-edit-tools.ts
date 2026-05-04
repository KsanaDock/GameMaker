import * as fs from 'fs/promises';
import * as path from 'path';
import ts from 'typescript';
import type { ToolRegistry } from './tool-registry.js';
import { getBlockedGameArtifactReason } from './game-file-guard.js';

export function registerStructuredEditTools(registry: ToolRegistry, projectRoot: string) {
    registry.register({
        name: 'json_edit',
        description: `Edit a JSON file by path instead of rewriting the entire file.
Use this for structured config changes. Path supports dot notation such as "scripts.player.speed" and array indexes such as "levels.0.name".`,
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'JSON file path relative to project root.' },
                operation: { type: 'string', enum: ['set', 'delete'], description: 'Operation to apply.' },
                json_path: { type: 'string', description: 'Dot path to edit, e.g. "a.b.0.c".' },
                value: { description: 'Value for set operations. Can be any JSON value.' },
                indent: { type: 'number', description: 'JSON indentation spaces. Default 2.' }
            },
            required: ['file_path', 'operation', 'json_path']
        },
        handler: async (args: any) => editJson(projectRoot, args)
    });

    registry.register({
        name: 'gdscript_edit_symbol',
        description: `Edit GDScript using symbol-level operations.
Use replace_function to replace a whole function by name, insert_function to append a function, and insert_after_extends to insert declarations near the top of the script.`,
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'GDScript file path relative to project root.' },
                operation: {
                    type: 'string',
                    enum: ['replace_function', 'insert_function', 'insert_after_extends'],
                    description: 'Symbol-level edit operation.'
                },
                symbol_name: { type: 'string', description: 'Function name for replace_function.' },
                content: { type: 'string', description: 'GDScript block to insert or replace.' }
            },
            required: ['file_path', 'operation', 'content']
        },
        handler: async (args: any) => editGdscriptSymbol(projectRoot, args)
    });

    registry.register({
        name: 'typescript_ast_edit',
        description: `Edit TypeScript/JavaScript using AST-aware operations.
Use replace_function for top-level functions or class methods, insert_import for ESM imports, and append_export for adding an exported declaration at the end of a module.`,
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'TypeScript or JavaScript file path relative to project root.' },
                operation: {
                    type: 'string',
                    enum: ['replace_function', 'insert_import', 'append_export'],
                    description: 'AST-aware edit operation.'
                },
                symbol_name: { type: 'string', description: 'Function or method name for replace_function.' },
                class_name: { type: 'string', description: 'Optional class name when replacing a method.' },
                import_clause: { type: 'string', description: 'Full import statement for insert_import.' },
                content: { type: 'string', description: 'Replacement function/method or appended export declaration.' }
            },
            required: ['file_path', 'operation']
        },
        handler: async (args: any) => editTypeScriptAst(projectRoot, args)
    });
}

async function editJson(projectRoot: string, args: any) {
    const filePath = String(args.file_path || '');
    const fullPath = resolveWritableFile(projectRoot, filePath);
    if (!fullPath) return { error: 'Permission denied: path outside project root.' };

    const blockedReason = getBlockedGameArtifactReason(filePath);
    if (blockedReason) return { error: blockedReason };

    try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const data = JSON.parse(content);
        const pathParts = parseJsonPath(String(args.json_path || ''));
        if (pathParts.length === 0) return { error: 'json_path is required.' };

        if (args.operation === 'set') {
            setJsonPath(data, pathParts, args.value);
        } else if (args.operation === 'delete') {
            deleteJsonPath(data, pathParts);
        } else {
            return { error: `Unsupported operation: ${args.operation}` };
        }

        const indent = clampNumber(args.indent, 2, 0, 8);
        await fs.writeFile(fullPath, `${JSON.stringify(data, null, indent)}\n`, 'utf-8');
        return { status: 'ok', file_path: toProjectRelative(projectRoot, fullPath), operation: args.operation };
    } catch (err: any) {
        return { error: err.message };
    }
}

async function editGdscriptSymbol(projectRoot: string, args: any) {
    const filePath = String(args.file_path || '');
    const fullPath = resolveWritableFile(projectRoot, filePath);
    if (!fullPath) return { error: 'Permission denied: path outside project root.' };

    const blockedReason = getBlockedGameArtifactReason(filePath);
    if (blockedReason) return { error: blockedReason };

    try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const normalizedBlock = normalizeGdscriptBlock(String(args.content || ''));
        if (!normalizedBlock.trim()) return { error: 'content is required.' };

        let nextContent = content;
        if (args.operation === 'replace_function') {
            const symbolName = String(args.symbol_name || '').trim();
            if (!symbolName) return { error: 'symbol_name is required for replace_function.' };
            nextContent = replaceGdscriptFunction(content, symbolName, normalizedBlock);
        } else if (args.operation === 'insert_function') {
            nextContent = `${content.trimEnd()}\n\n${normalizedBlock}\n`;
        } else if (args.operation === 'insert_after_extends') {
            nextContent = insertAfterTopDirectives(content, normalizedBlock);
        } else {
            return { error: `Unsupported operation: ${args.operation}` };
        }

        await fs.writeFile(fullPath, nextContent, 'utf-8');
        return { status: 'ok', file_path: toProjectRelative(projectRoot, fullPath), operation: args.operation };
    } catch (err: any) {
        return { error: err.message };
    }
}

async function editTypeScriptAst(projectRoot: string, args: any) {
    const filePath = String(args.file_path || '');
    const fullPath = resolveWritableFile(projectRoot, filePath);
    if (!fullPath) return { error: 'Permission denied: path outside project root.' };

    const blockedReason = getBlockedGameArtifactReason(filePath);
    if (blockedReason) return { error: blockedReason };

    try {
        const content = await fs.readFile(fullPath, 'utf-8');
        const sourceFile = ts.createSourceFile(
            fullPath,
            content,
            ts.ScriptTarget.Latest,
            true,
            filePath.endsWith('.tsx') || filePath.endsWith('.jsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS
        );

        let nextContent = content;
        if (args.operation === 'replace_function') {
            const symbolName = String(args.symbol_name || '').trim();
            if (!symbolName) return { error: 'symbol_name is required for replace_function.' };
            nextContent = replaceTypeScriptFunction(content, sourceFile, symbolName, String(args.content || ''), String(args.class_name || '').trim());
        } else if (args.operation === 'insert_import') {
            nextContent = insertTypeScriptImport(content, sourceFile, String(args.import_clause || ''));
        } else if (args.operation === 'append_export') {
            nextContent = `${content.trimEnd()}\n\n${String(args.content || '').trimEnd()}\n`;
        } else {
            return { error: `Unsupported operation: ${args.operation}` };
        }

        await fs.writeFile(fullPath, nextContent, 'utf-8');
        return { status: 'ok', file_path: toProjectRelative(projectRoot, fullPath), operation: args.operation };
    } catch (err: any) {
        return { error: err.message };
    }
}

function replaceGdscriptFunction(content: string, functionName: string, replacement: string): string {
    const lines = content.split(/\r?\n/);
    const start = lines.findIndex(line => new RegExp(`^\\s*func\\s+${escapeRegExp(functionName)}\\s*\\(`).test(line));
    if (start === -1) {
        throw new Error(`Function not found: ${functionName}`);
    }

    const baseIndent = getIndent(lines[start] || '');
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) {
        const line = lines[i] || '';
        if (line.trim() === '') continue;
        const indent = getIndent(line);
        if (indent.length <= baseIndent.length && isTopLevelGdscriptLine(line)) {
            end = i;
            break;
        }
    }

    const replacementLines = normalizeGdscriptBlock(replacement).split('\n');
    return [...lines.slice(0, start), ...replacementLines, ...lines.slice(end)].join('\n');
}

function insertAfterTopDirectives(content: string, block: string): string {
    const lines = content.split(/\r?\n/);
    let insertAt = 0;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = (lines[i] || '').trim();
        if (
            trimmed === '' ||
            trimmed.startsWith('@tool') ||
            trimmed.startsWith('extends ') ||
            trimmed.startsWith('class_name ')
        ) {
            insertAt = i + 1;
            continue;
        }
        break;
    }

    const before = lines.slice(0, insertAt);
    const after = lines.slice(insertAt);
    return [...before, '', ...normalizeGdscriptBlock(block).split('\n'), '', ...after].join('\n').replace(/\n{4,}/g, '\n\n\n');
}

function replaceTypeScriptFunction(
    content: string,
    sourceFile: ts.SourceFile,
    symbolName: string,
    replacement: string,
    className: string
): string {
    const normalizedReplacement = replacement.trimEnd();
    if (!normalizedReplacement.trim()) {
        throw new Error('content is required for replace_function.');
    }

    let target: ts.Node | null = null;

    function visit(node: ts.Node) {
        if (target) return;

        if (!className && ts.isFunctionDeclaration(node) && node.name?.text === symbolName) {
            target = node;
            return;
        }

        if (ts.isClassDeclaration(node) && node.name?.text === className) {
            for (const member of node.members) {
                if (ts.isMethodDeclaration(member) && getPropertyNameText(member.name) === symbolName) {
                    target = member;
                    return;
                }
            }
        }

        ts.forEachChild(node, visit);
    }

    visit(sourceFile);
    if (!target) {
        throw new Error(className ? `Method not found: ${className}.${symbolName}` : `Function not found: ${symbolName}`);
    }

    return replaceNodeText(content, sourceFile, target, normalizedReplacement);
}

function insertTypeScriptImport(content: string, sourceFile: ts.SourceFile, importClause: string): string {
    const normalizedImport = importClause.trim().replace(/;?$/, ';');
    if (!/^import\s/.test(normalizedImport)) {
        throw new Error('import_clause must be a full ESM import statement.');
    }
    if (content.includes(normalizedImport)) {
        return content;
    }

    const imports = sourceFile.statements.filter(ts.isImportDeclaration);
    if (imports.length === 0) {
        return `${normalizedImport}\n${content}`;
    }

    const lastImport = imports[imports.length - 1]!;
    const insertAt = lastImport.getEnd();
    return `${content.slice(0, insertAt)}\n${normalizedImport}${content.slice(insertAt)}`;
}

function replaceNodeText(content: string, sourceFile: ts.SourceFile, node: ts.Node, replacement: string): string {
    const start = node.getFullStart();
    const leading = content.slice(start, node.getStart(sourceFile));
    const end = node.getEnd();
    return `${content.slice(0, start)}${leading}${replacement}${content.slice(end)}`;
}

function getPropertyNameText(name: ts.PropertyName): string {
    if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
        return name.text;
    }
    return name.getText();
}

function isTopLevelGdscriptLine(line: string): boolean {
    const trimmed = line.trim();
    return /^(func|signal|const|var|@|class_name|extends)\b/.test(trimmed);
}

function normalizeGdscriptBlock(block: string): string {
    return block.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
}

function parseJsonPath(jsonPath: string): Array<string | number> {
    return jsonPath
        .split('.')
        .map(part => part.trim())
        .filter(Boolean)
        .map(part => /^\d+$/.test(part) ? Number(part) : part);
}

function setJsonPath(target: any, parts: Array<string | number>, value: any) {
    let current = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        const nextPart = parts[i + 1]!;
        if (current[part] === undefined || current[part] === null) {
            current[part] = typeof nextPart === 'number' ? [] : {};
        }
        current = current[part];
    }
    current[parts[parts.length - 1]!] = value;
}

function deleteJsonPath(target: any, parts: Array<string | number>) {
    let current = target;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i]!;
        if (current[part] === undefined || current[part] === null) return;
        current = current[part];
    }
    const last = parts[parts.length - 1]!;
    if (Array.isArray(current) && typeof last === 'number') {
        current.splice(last, 1);
    } else {
        delete current[last];
    }
}

function resolveWritableFile(projectRoot: string, filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/').replace(/^res:\/\//, '').replace(/^\.\//, '');
    const fullPath = path.resolve(projectRoot, normalized);
    return isInside(projectRoot, fullPath) ? fullPath : null;
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function toProjectRelative(projectRoot: string, fullPath: string): string {
    return path.relative(path.resolve(projectRoot), path.resolve(fullPath)).replace(/\\/g, '/');
}

function getIndent(line: string): string {
    return line.match(/^\s*/)?.[0] || '';
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
}
