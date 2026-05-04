import * as fs from 'fs/promises';
import * as path from 'path';
import { getBlockedGameArtifactReason } from './game-file-guard.js';

export function registerPatchTools(registry: any, projectRoot: string) {
    registry.register({
        name: 'file_edit',
        description: `Performs exact string replacements in files.

Usage:
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- The edit will FAIL if \`old_string\` is not unique in the file. Either provide a larger string with more surrounding context to make it unique or use \`replace_all\` to change every instance of \`old_string\`.
- Use \`replace_all\` for replacing and renaming strings across the file. This parameter is useful if you want to rename a variable for instance.`,
        parameters: {
            type: 'object',
            properties: {
                file_path: { type: 'string', description: 'File path relative to project root' },
                old_string: { type: 'string', description: 'The exact string to replace. Must be unique in the file unless replace_all is true.' },
                new_string: { type: 'string', description: 'The replacement string' },
                replace_all: { type: 'boolean', description: 'If true, replaces all occurrences of old_string' }
            },
            required: ['file_path', 'old_string', 'new_string']
        },
        handler: async (args: any) => {
            const { file_path, old_string, new_string, replace_all = false } = args;
            const blockedReason = getBlockedGameArtifactReason(file_path || '');
            if (blockedReason) {
                return { error: blockedReason };
            }

            const fullPath = path.resolve(projectRoot, file_path);
            
            if (!fullPath.startsWith(projectRoot)) {
                return { error: 'Permission denied: path outside project root' };
            }

            try {
                const content = await fs.readFile(fullPath, 'utf-8');
                
                if (old_string === new_string) {
                    return { error: 'No changes to make: old_string and new_string are exactly the same.' };
                }

                if (!content.includes(old_string)) {
                    return { error: `String to replace not found in file.\nString: ${old_string}` };
                }

                const matches = content.split(old_string).length - 1;

                if (matches > 1 && !replace_all) {
                    return { 
                        error: `Found ${matches} matches of the string to replace, but replace_all is false. To replace all occurrences, set replace_all to true. To replace only one occurrence, please provide more context to uniquely identify the instance.\nString: ${old_string}` 
                    };
                }

                const newContent = replace_all 
                    ? content.split(old_string).join(new_string) 
                    : content.replace(old_string, new_string);
                
                await fs.writeFile(fullPath, newContent, 'utf-8');
                
                return { 
                    status: 'ok', 
                    message: replace_all ? `Successfully replaced ${matches} occurrences.` : 'Successfully edited file.'
                };
            } catch (e: any) {
                return { error: e.message };
            }
        }
    });
}
