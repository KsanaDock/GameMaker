import * as fs from 'fs/promises';
import * as path from 'path';
import { ensureKsanadockDir } from './project-data.js';

export const ENTRYPOINT_NAME = 'MEMORY.md';
export const MAX_ENTRYPOINT_LINES = 200;
export const MAX_ENTRYPOINT_BYTES = 25000;

export async function ensureMemoryDirExists(memoryDir: string): Promise<void> {
    try {
        await fs.mkdir(memoryDir, { recursive: true });
    } catch (e) {
        // Ignore if exists
    }
}

export function truncateEntrypointContent(raw: string): string {
    const trimmed = raw.trim();
    const contentLines = trimmed.split('\n');
    const lineCount = contentLines.length;
    const byteCount = trimmed.length;

    const wasLineTruncated = lineCount > MAX_ENTRYPOINT_LINES;
    const wasByteTruncated = byteCount > MAX_ENTRYPOINT_BYTES;

    if (!wasLineTruncated && !wasByteTruncated) {
        return trimmed;
    }

    let truncated = wasLineTruncated
        ? contentLines.slice(0, MAX_ENTRYPOINT_LINES).join('\n')
        : trimmed;

    if (truncated.length > MAX_ENTRYPOINT_BYTES) {
        const cutAt = truncated.lastIndexOf('\n', MAX_ENTRYPOINT_BYTES);
        truncated = truncated.slice(0, cutAt > 0 ? cutAt : MAX_ENTRYPOINT_BYTES);
    }

    const reason =
        wasByteTruncated && !wasLineTruncated
            ? `${byteCount} bytes (limit: ${MAX_ENTRYPOINT_BYTES}) — index entries are too long`
            : wasLineTruncated && !wasByteTruncated
                ? `${lineCount} lines (limit: ${MAX_ENTRYPOINT_LINES})`
                : `${lineCount} lines and ${byteCount} bytes`;

    return truncated + `\n\n> WARNING: ${ENTRYPOINT_NAME} is ${reason}. Only part of it was loaded. Keep index entries to one line under ~200 chars; move detail into topic files.`;
}

export async function buildMemoryPrompt(projectRoot: string): Promise<string> {
    const ksanadockDir = await ensureKsanadockDir(projectRoot);
    const memoryDir = path.join(ksanadockDir, 'memory');
    await ensureMemoryDirExists(memoryDir);

    const entrypoint = path.join(memoryDir, ENTRYPOINT_NAME);
    let entrypointContent = '';
    try {
        entrypointContent = await fs.readFile(entrypoint, 'utf-8');
    } catch {
        // No memory file yet
    }

    const lines: string[] = [
        '# Auto Memory',
        '',
        `You have a persistent, file-based memory system at ${memoryDir}. This directory already exists — write to it directly with the write_file tool.`,
        '',
        "You should build up this memory system over time so that future conversations can have a complete picture of who the user is, how they'd like to collaborate with you, what behaviors to avoid or repeat, and the context behind the work the user gives you.",
        '',
        'If the user explicitly asks you to remember something, save it immediately as whichever type fits best. If they ask you to forget something, find and remove the relevant entry using file_edit or write_file.',
        '',
        '## What to save',
        '- User corrections and preferences ("stop summarizing diffs", "use gdscript 2.0")',
        '- Facts about the user, their role, or their goals',
        '- Project context that is not derivable from the code (deadlines, decisions and their rationale)',
        '',
        '## How to save memories',
        '',
        'Saving a memory is a two-step process:',
        '',
        `**Step 1** — write the memory to its own file (e.g., \`user_role.md\`, \`feedback_testing.md\`) inside ${memoryDir} using this frontmatter format:`,
        '',
        '---',
        'name: name of the memory',
        'description: a brief description of the memory',
        'type: user | feedback | project',
        '---',
        '',
        `**Step 2** — add a pointer to that file in ${ENTRYPOINT_NAME}. ${ENTRYPOINT_NAME} is an index, not a memory — each entry should be one line, under ~150 characters: \`- [Title](file.md) — one-line hook\`. It has no frontmatter. Never write memory content directly into ${ENTRYPOINT_NAME}.`,
        '',
        `- ${ENTRYPOINT_NAME} is always loaded into your conversation context — lines after ${MAX_ENTRYPOINT_LINES} will be truncated, so keep the index concise`,
        '- Keep the name, description, and type fields in memory files up-to-date with the content',
        '- Organize memory semantically by topic, not chronologically',
        '- Update or remove memories that turn out to be wrong or outdated. First check if there is an existing memory you can update before writing a new one.',
        '',
        '## Searching past context',
        `When looking for past context, ALWAYS search topic files in your memory directory using the \`grep_search\` tool first:`,
        `\`\`\`
grep_search with pattern="<search term>", directory="${memoryDir}", include_glob="*.md"
\`\`\``
    ];

    if (entrypointContent.trim()) {
        const t = truncateEntrypointContent(entrypointContent);
        lines.push(`## ${ENTRYPOINT_NAME}`, '', t);
    } else {
        lines.push(
            `## ${ENTRYPOINT_NAME}`,
            '',
            `Your ${ENTRYPOINT_NAME} is currently empty. When you save new memories, they will appear here.`
        );
    }

    return lines.join('\n');
}
