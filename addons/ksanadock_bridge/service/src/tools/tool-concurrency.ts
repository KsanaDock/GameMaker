const PARALLEL_SAFE_TOOLS = new Set([
    'list_dir',
    'read_file',
    'grep_search',
    'grep_symbols',
    'get_file_symbols',
    'analyze_image',
    'checkpoint_list',
    'checkpoint_get',
    'task_list',
    'task_get'
]);

export function isParallelSafeTool(name: string): boolean {
    return PARALLEL_SAFE_TOOLS.has(name);
}
