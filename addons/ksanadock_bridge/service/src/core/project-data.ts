import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';

const GDIGNORE_CONTENT = '# KsanaDock runtime data. Godot should not import this directory.\n';

export async function ensureKsanadockDir(projectRoot: string): Promise<string> {
    const dir = path.join(projectRoot, '.ksanadock');
    await fsp.mkdir(dir, { recursive: true });
    await ensureGdignore(dir);
    return dir;
}

export function ensureKsanadockDirSync(projectRoot: string): string {
    const dir = path.join(projectRoot, '.ksanadock');
    fs.mkdirSync(dir, { recursive: true });
    ensureGdignoreSync(dir);
    return dir;
}

async function ensureGdignore(dir: string): Promise<void> {
    const gdignorePath = path.join(dir, '.gdignore');
    try {
        await fsp.writeFile(gdignorePath, GDIGNORE_CONTENT, { flag: 'wx' });
    } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
    }
}

function ensureGdignoreSync(dir: string): void {
    const gdignorePath = path.join(dir, '.gdignore');
    if (!fs.existsSync(gdignorePath)) {
        fs.writeFileSync(gdignorePath, GDIGNORE_CONTENT, 'utf-8');
    }
}
