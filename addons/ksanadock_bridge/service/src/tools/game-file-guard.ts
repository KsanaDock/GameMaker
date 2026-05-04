export function getBlockedGameArtifactReason(filePath: string): string | null {
    const normalized = filePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
    const fileName = normalized.split('/').pop() || '';

    if (normalized.startsWith('scenes/test/') || normalized.startsWith('scripts/test/')) {
        return 'Game development agents must not create or edit test scene/script folders. Build production playable scenes instead.';
    }

    if (fileName === 'test_scene.tscn' || fileName === 'ai_test_scene.tscn') {
        return 'Game development agents must not create test scenes. Use the official playable scene for validation.';
    }

    if (fileName.endsWith('_test.gd') || fileName.endsWith('.test.gd')) {
        return 'Game development agents must not create GDScript test files. Validate production scripts directly.';
    }

    return null;
}
