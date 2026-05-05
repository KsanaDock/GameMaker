import axios from 'axios';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { execFile } from 'child_process';
import { promisify } from 'util';
import type { ToolRegistry } from './tool-registry.js';
import { ensureKsanadockDir } from '../core/project-data.js';

const execFileAsync = promisify(execFile);

interface WebSearchResult {
    title: string;
    url: string;
    snippet: string;
    query: string;
}

interface PageSummary {
    title: string;
    description: string;
    excerpts: string[];
    textFile: string;
}

interface GitHubRepository {
    fullName: string;
    description: string;
    htmlUrl: string;
    cloneUrl: string;
    stars: number;
    forks: number;
    language: string;
    license: string;
    updatedAt: string;
    topics: string[];
}

interface ClonedRepository {
    fullName: string;
    htmlUrl: string;
    localPath: string;
    status: 'cloned' | 'exists' | 'failed';
    message: string;
}

const http = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    maxContentLength: 2_000_000,
    headers: {
        'User-Agent': 'KsanaDock-Agent-Research/1.0 (+https://github.com/ksanadock/godotmaker)',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7'
    }
});

export function registerResearchTools(registry: ToolRegistry, projectRoot: string) {
    registry.register({
        name: 'web_search_references',
        description: `Search the public web for game design, technical, art, UX, or Godot implementation references.
Use this before implementing unfamiliar game concepts. The tool saves a concise Markdown research brief and fetched page text under .ksanadock/references/.
Prefer focused English queries for broader results, but include Chinese queries when the user's game concept is China-specific.`,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Primary web search query.' },
                queries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional list of related queries to search together.'
                },
                maxResults: { type: 'number', description: 'Maximum total web results to keep. Default 6, max 12.' },
                folderName: { type: 'string', description: 'Optional references subfolder name.' }
            },
            required: ['query']
        },
        handler: async (args: any) => {
            const referenceProjectRoot = await resolveReferenceProjectRoot(projectRoot);
            const referencesRoot = await ensureReferencesRoot(referenceProjectRoot);
            const folder = await createReferenceFolder(referencesRoot, args.folderName || args.query);
            const queries = normalizeQueries([args.query, ...(Array.isArray(args.queries) ? args.queries : [])]);
            const maxResults = clampNumber(args.maxResults, 6, 1, 12);
            const results = await searchWebAcrossQueries(queries, maxResults);
            const summaries = await summarizeWebResults(results, queries.join(' '), folder);
            const briefPath = await writeWebBrief(folder, args.query, queries, results, summaries, referenceProjectRoot);

            await appendReferenceIndex(referencesRoot, {
                title: `Web research: ${args.query}`,
                folder,
                files: [briefPath]
            }, referenceProjectRoot);

            return {
                status: 'ok',
                folder: toProjectRelative(referenceProjectRoot, folder),
                brief: toProjectRelative(referenceProjectRoot, briefPath),
                resultCount: results.length,
                sources: results.map(r => ({ title: r.title, url: r.url }))
            };
        }
    });

    registry.register({
        name: 'github_search_repositories',
        description: `Search GitHub for open-source projects that can be used as implementation references.
This only indexes repositories and writes metadata to .ksanadock/references/; use clone_github_repository or collect_game_references with cloneTopRepositories=true to download code.
Always inspect licenses before copying code or assets.`,
        parameters: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'GitHub repository search query. Example: "tower defense godot".' },
                language: { type: 'string', description: 'Optional GitHub language qualifier, e.g. GDScript, C#, TypeScript. Defaults to GDScript.' },
                maxResults: { type: 'number', description: 'Maximum repositories to list. Default 8, max 20.' },
                folderName: { type: 'string', description: 'Optional references subfolder name.' }
            },
            required: ['query']
        },
        handler: async (args: any) => {
            const referenceProjectRoot = await resolveReferenceProjectRoot(projectRoot);
            const referencesRoot = await ensureReferencesRoot(referenceProjectRoot);
            const folder = await createReferenceFolder(referencesRoot, args.folderName || args.query);
            const repositories = await searchGitHubRepositories(
                args.query,
                typeof args.language === 'string' ? args.language : 'GDScript',
                clampNumber(args.maxResults, 8, 1, 20)
            );
            const reportPath = await writeGitHubReport(folder, args.query, repositories, []);

            await appendReferenceIndex(referencesRoot, {
                title: `GitHub search: ${args.query}`,
                folder,
                files: [reportPath]
            }, referenceProjectRoot);

            return {
                status: 'ok',
                folder: toProjectRelative(referenceProjectRoot, folder),
                report: toProjectRelative(referenceProjectRoot, reportPath),
                repositories
            };
        }
    });

    registry.register({
        name: 'clone_github_repository',
        description: `Clone a GitHub repository into .ksanadock/references/github/ for local reading.
Only GitHub repositories are accepted. Use this for reference code, not as a dependency installer. Always treat cloned code/assets according to their license.`,
        parameters: {
            type: 'object',
            properties: {
                repository: { type: 'string', description: 'GitHub URL or owner/repo identifier.' },
                folderName: { type: 'string', description: 'Optional references subfolder name. Defaults to github.' }
            },
            required: ['repository']
        },
        handler: async (args: any) => {
            const referenceProjectRoot = await resolveReferenceProjectRoot(projectRoot);
            const referencesRoot = await ensureReferencesRoot(referenceProjectRoot);
            const folder = path.join(referencesRoot, sanitizePathSegment(args.folderName || 'github'));
            await fs.mkdir(folder, { recursive: true });
            const parsed = parseGitHubRepository(args.repository);
            const cloned = await cloneGitHubRepository(parsed, folder, referenceProjectRoot);
            return {
                status: cloned.status,
                repository: cloned.fullName,
                localPath: cloned.localPath,
                message: cloned.message
            };
        }
    });

    registry.register({
        name: 'collect_game_references',
        description: `One-stop research package for a new game idea.
It brainstorms practical search angles from the concept, searches the web, searches GitHub, writes Markdown summaries under .ksanadock/references/, and can optionally clone top GitHub repositories into .ksanadock/references/<package>/github/.
Call this before building a non-trivial new game, genre prototype, mechanic, or unfamiliar system. Keep cloned repositories to 1-2 unless the user explicitly asks for more.`,
        parameters: {
            type: 'object',
            properties: {
                concept: { type: 'string', description: 'The game idea or mechanic the user wants to build.' },
                searchQueries: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Optional focused web search queries. Use English keywords when possible.'
                },
                githubQuery: { type: 'string', description: 'Optional GitHub search query. Example: "vampire survivors godot".' },
                includeWeb: { type: 'boolean', description: 'Whether to search general web references. Defaults to true.' },
                includeGithub: { type: 'boolean', description: 'Whether to search GitHub repositories. Defaults to true.' },
                cloneTopRepositories: { type: 'boolean', description: 'Whether to clone top GitHub repositories into references. Defaults to false.' },
                maxWebResults: { type: 'number', description: 'Maximum web results. Default 8, max 16.' },
                maxGithubResults: { type: 'number', description: 'Maximum GitHub repositories in report. Default 8, max 20.' },
                maxRepositoriesToClone: { type: 'number', description: 'Maximum repositories to clone. Default 1, max 3.' }
            },
            required: ['concept']
        },
        handler: async (args: any) => {
            const referenceProjectRoot = await resolveReferenceProjectRoot(projectRoot);
            const referencesRoot = await ensureReferencesRoot(referenceProjectRoot);
            const packageFolder = await createReferenceFolder(referencesRoot, args.concept);
            const includeWeb = args.includeWeb !== false;
            const includeGithub = args.includeGithub !== false;
            const maxWebResults = clampNumber(args.maxWebResults, 8, 1, 16);
            const maxGithubResults = clampNumber(args.maxGithubResults, 8, 1, 20);
            const maxRepositoriesToClone = clampNumber(args.maxRepositoriesToClone, 1, 1, 3);

            let webResults: WebSearchResult[] = [];
            let webSummaries = new Map<string, PageSummary>();
            let webBriefPath = '';

            if (includeWeb) {
                const queries = normalizeQueries(
                    Array.isArray(args.searchQueries) && args.searchQueries.length > 0
                        ? args.searchQueries
                        : buildGameSearchQueries(args.concept)
                );
                webResults = await searchWebAcrossQueries(queries, maxWebResults);
                webSummaries = await summarizeWebResults(webResults, queries.join(' '), packageFolder);
                webBriefPath = await writeWebBrief(packageFolder, args.concept, queries, webResults, webSummaries, referenceProjectRoot);
            }

            let repositories: GitHubRepository[] = [];
            let clonedRepositories: ClonedRepository[] = [];
            let githubReportPath = '';

            if (includeGithub) {
                const githubQuery = typeof args.githubQuery === 'string' && args.githubQuery.trim()
                    ? args.githubQuery.trim()
                    : `${args.concept} godot game`;
                repositories = await searchGitHubRepositories(githubQuery, 'GDScript', maxGithubResults);

                if (args.cloneTopRepositories === true && repositories.length > 0) {
                    const cloneFolder = path.join(packageFolder, 'github');
                    await fs.mkdir(cloneFolder, { recursive: true });
                    for (const repo of repositories.slice(0, maxRepositoriesToClone)) {
                        clonedRepositories.push(await cloneGitHubRepository({
                            fullName: repo.fullName,
                            htmlUrl: repo.htmlUrl,
                            cloneUrl: repo.cloneUrl
                        }, cloneFolder, referenceProjectRoot));
                    }
                }

                githubReportPath = await writeGitHubReport(packageFolder, githubQuery, repositories, clonedRepositories);
            }

            const overviewPath = await writeGameResearchOverview(packageFolder, args.concept, webBriefPath, githubReportPath, clonedRepositories);

            const files = [overviewPath];
            if (webBriefPath) files.push(webBriefPath);
            if (githubReportPath) files.push(githubReportPath);

            await appendReferenceIndex(referencesRoot, {
                title: `Game research package: ${args.concept}`,
                folder: packageFolder,
                files
            }, referenceProjectRoot);

            return {
                status: 'ok',
                folder: toProjectRelative(referenceProjectRoot, packageFolder),
                overview: toProjectRelative(referenceProjectRoot, overviewPath),
                webBrief: webBriefPath ? toProjectRelative(referenceProjectRoot, webBriefPath) : '',
                githubReport: githubReportPath ? toProjectRelative(referenceProjectRoot, githubReportPath) : '',
                webResultCount: webResults.length,
                githubResultCount: repositories.length,
                clonedRepositories: clonedRepositories.map(r => ({
                    repository: r.fullName,
                    status: r.status,
                    localPath: r.localPath,
                    message: r.message
                }))
            };
        }
    });
}

async function ensureReferencesRoot(projectRoot: string): Promise<string> {
    const ksanadockDir = await ensureKsanadockDir(projectRoot);
    const referencesRoot = path.resolve(ksanadockDir, 'references');
    if (!isInside(projectRoot, referencesRoot)) {
        throw new Error('Resolved references path is outside the project root.');
    }

    await fs.mkdir(referencesRoot, { recursive: true });
    const gdignorePath = path.join(referencesRoot, '.gdignore');
    try {
        await fs.writeFile(
            gdignorePath,
            '# External research and reference material. Godot should not import this directory.\n',
            { flag: 'wx' }
        );
    } catch (err: any) {
        if (err.code !== 'EEXIST') throw err;
    }

    return referencesRoot;
}

async function resolveReferenceProjectRoot(projectRoot: string): Promise<string> {
    let current = path.resolve(projectRoot);

    while (true) {
        try {
            await fs.access(path.join(current, 'project.godot'));
            return current;
        } catch {
            // Keep walking upward until the filesystem root.
        }

        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(projectRoot);
        }
        current = parent;
    }
}

async function createReferenceFolder(referencesRoot: string, seed: string): Promise<string> {
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const folder = path.join(referencesRoot, `${stamp}-${slugify(seed)}`);
    await fs.mkdir(folder, { recursive: true });
    return folder;
}

function buildGameSearchQueries(concept: string): string[] {
    return [
        `${concept} game design mechanics`,
        `${concept} gameplay loop progression`,
        `${concept} Godot implementation tutorial`,
        `${concept} open source game GitHub`
    ];
}

async function searchWebAcrossQueries(queries: string[], maxResults: number): Promise<WebSearchResult[]> {
    const results: WebSearchResult[] = [];
    const seen = new Set<string>();
    const perQuery = Math.max(3, Math.ceil(maxResults / Math.max(1, queries.length)) + 1);

    for (const query of queries) {
        const queryResults = await duckDuckGoSearch(query, perQuery);
        for (const result of queryResults) {
            const key = normalizeUrlKey(result.url);
            if (seen.has(key)) continue;
            seen.add(key);
            results.push(result);
            if (results.length >= maxResults) return results;
        }
    }

    return results;
}

async function duckDuckGoSearch(query: string, maxResults: number): Promise<WebSearchResult[]> {
    try {
        const response = await http.get('https://html.duckduckgo.com/html/', {
            params: { q: query },
            responseType: 'text'
        });
        const html = typeof response.data === 'string' ? response.data : String(response.data);
        return parseDuckDuckGoResults(html, query).slice(0, maxResults);
    } catch {
        return [];
    }
}

function parseDuckDuckGoResults(html: string, query: string): WebSearchResult[] {
    const results: WebSearchResult[] = [];
    const matches = Array.from(html.matchAll(/<a([^>]+)>([\s\S]*?)<\/a>/gi))
        .filter(match => (match[1] || '').includes('result__a'));

    for (let i = 0; i < matches.length; i++) {
        const match = matches[i];
        if (!match) continue;
        const attrs = match[1] || '';
        const href = attrs.match(/href="([^"]+)"/i)?.[1] || '';
        const titleHtml = match[2] || '';
        const start = match.index ?? 0;
        const next = matches[i + 1]?.index ?? html.length;
        const block = html.slice(start, next);
        const snippetMatch = block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i)
            || block.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/div>/i);

        const url = unwrapDuckDuckGoUrl(decodeHtmlEntities(href));
        if (!url || url === 'about:blank') continue;

        results.push({
            title: stripHtml(titleHtml).trim() || url,
            url,
            snippet: snippetMatch ? stripHtml(snippetMatch[1] || '').trim() : '',
            query
        });
    }

    return results;
}

function unwrapDuckDuckGoUrl(rawUrl: string): string {
    let url = rawUrl;
    if (url.startsWith('//')) url = `https:${url}`;
    if (url.startsWith('/')) url = `https://duckduckgo.com${url}`;

    try {
        const parsed = new URL(url);
        const uddg = parsed.searchParams.get('uddg');
        if (uddg) return decodeURIComponent(uddg);
        return parsed.href;
    } catch {
        return '';
    }
}

async function summarizeWebResults(results: WebSearchResult[], queryText: string, folder: string): Promise<Map<string, PageSummary>> {
    const summaries = new Map<string, PageSummary>();
    const pagesFolder = path.join(folder, 'web_pages');
    await fs.mkdir(pagesFolder, { recursive: true });

    for (const result of results) {
        if (result.url === 'about:blank') continue;
        try {
            const summary = await fetchPageSummary(result, queryText, pagesFolder);
            summaries.set(result.url, summary);
        } catch {
            // Snippets are still useful when full page fetch fails.
        }
    }

    return summaries;
}

async function fetchPageSummary(result: WebSearchResult, queryText: string, pagesFolder: string): Promise<PageSummary> {
    const response = await http.get(result.url, {
        responseType: 'text',
        validateStatus: status => status >= 200 && status < 400
    });
    const contentType = String(response.headers['content-type'] || '').toLowerCase();
    if (contentType && !contentType.includes('text/') && !contentType.includes('html') && !contentType.includes('xml')) {
        throw new Error(`Unsupported content type: ${contentType}`);
    }

    const html = typeof response.data === 'string' ? response.data : String(response.data);
    const title = extractHtmlTitle(html) || result.title;
    const description = extractMetaDescription(html);
    const text = stripHtml(html).slice(0, 60000);
    const excerpts = selectUsefulExcerpts(text, `${queryText} ${result.title} ${result.snippet}`, 5);
    const fileName = `${slugify(result.title || result.url)}.txt`;
    const textFilePath = path.join(pagesFolder, fileName);
    await fs.writeFile(
        textFilePath,
        `URL: ${result.url}\nTitle: ${title}\nDescription: ${description}\n\n${text.slice(0, 20000)}\n`,
        'utf-8'
    );

    return {
        title,
        description,
        excerpts,
        textFile: textFilePath
    };
}

async function searchGitHubRepositories(query: string, language: string, maxResults: number): Promise<GitHubRepository[]> {
    const cleanQuery = query.trim();
    const languageQualifier = language.trim() ? ` language:${language.trim()}` : '';
    const q = `${cleanQuery}${cleanQuery.includes('language:') ? '' : languageQualifier}`;
    const repositories = await searchGitHubRepositoriesOnce(q, maxResults);

    if (repositories.length > 0 || !language.trim() || cleanQuery.includes('language:')) {
        return repositories;
    }

    return searchGitHubRepositoriesOnce(cleanQuery, maxResults);
}

async function searchGitHubRepositoriesOnce(query: string, maxResults: number): Promise<GitHubRepository[]> {
    const headers: Record<string, string> = {
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'KsanaDock-Agent-Research/1.0'
    };

    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (token) headers.Authorization = `Bearer ${token}`;

    const response = await axios.get('https://api.github.com/search/repositories', {
        params: {
            q: query,
            sort: 'stars',
            order: 'desc',
            per_page: maxResults
        },
        headers,
        timeout: 20000
    });

    const items = Array.isArray(response.data?.items) ? response.data.items : [];
    return items.map((item: any) => ({
        fullName: String(item.full_name || ''),
        description: String(item.description || ''),
        htmlUrl: String(item.html_url || ''),
        cloneUrl: String(item.clone_url || ''),
        stars: Number(item.stargazers_count || 0),
        forks: Number(item.forks_count || 0),
        language: String(item.language || ''),
        license: String(item.license?.spdx_id || item.license?.name || 'NOASSERTION'),
        updatedAt: String(item.updated_at || ''),
        topics: Array.isArray(item.topics) ? item.topics.map((topic: any) => String(topic)) : []
    }));
}

async function cloneGitHubRepository(repo: { fullName: string; htmlUrl: string; cloneUrl: string }, destinationFolder: string, projectRoot: string): Promise<ClonedRepository> {
    const parsed = parseGitHubRepository(repo.fullName || repo.htmlUrl || repo.cloneUrl);
    const folderName = sanitizePathSegment(parsed.fullName.replace('/', '__'));
    const target = path.resolve(destinationFolder, folderName);

    if (!isInside(projectRoot, target) || !isInside(path.resolve(projectRoot, '.ksanadock', 'references'), target)) {
        throw new Error('Refusing to clone outside the project references directory.');
    }

    try {
        await fs.access(target);
        return {
            fullName: parsed.fullName,
            htmlUrl: parsed.htmlUrl,
            localPath: toProjectRelative(projectRoot, target),
            status: 'exists',
            message: 'Repository folder already exists.'
        };
    } catch {
        // Folder does not exist yet.
    }

    try {
        await execFileAsync('git', ['clone', '--depth', '1', parsed.cloneUrl, target], {
            timeout: 300000,
            maxBuffer: 1024 * 1024
        });

        await fs.writeFile(
            path.join(target, 'KSANADOCK_REFERENCE.md'),
            [
                `# ${parsed.fullName}`,
                '',
                `Source: ${parsed.htmlUrl}`,
                '',
                'This repository was cloned by KsanaDock as reference material.',
                'Inspect the upstream license before copying code, assets, shaders, or data into the game project.',
                ''
            ].join('\n'),
            'utf-8'
        );

        return {
            fullName: parsed.fullName,
            htmlUrl: parsed.htmlUrl,
            localPath: toProjectRelative(projectRoot, target),
            status: 'cloned',
            message: 'Repository cloned for local reference.'
        };
    } catch (err: any) {
        return {
            fullName: parsed.fullName,
            htmlUrl: parsed.htmlUrl,
            localPath: toProjectRelative(projectRoot, target),
            status: 'failed',
            message: err.message || 'git clone failed.'
        };
    }
}

function parseGitHubRepository(input: string): { fullName: string; htmlUrl: string; cloneUrl: string } {
    const trimmed = String(input || '').trim();
    const match = trimmed.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/?#].*)?$/i)
        || trimmed.match(/^([^/\s]+)\/([^/\s]+)$/);

    if (!match) {
        throw new Error('Expected a GitHub repository URL or owner/repo identifier.');
    }

    const owner = sanitizeOwnerRepoPart(match[1] || '');
    const repo = sanitizeOwnerRepoPart((match[2] || '').replace(/\.git$/i, ''));
    if (!owner || !repo) {
        throw new Error('Invalid GitHub owner/repo identifier.');
    }

    const fullName = `${owner}/${repo}`;
    return {
        fullName,
        htmlUrl: `https://github.com/${fullName}`,
        cloneUrl: `https://github.com/${fullName}.git`
    };
}

async function writeWebBrief(
    folder: string,
    concept: string,
    queries: string[],
    results: WebSearchResult[],
    summaries: Map<string, PageSummary>,
    projectRoot: string
): Promise<string> {
    const lines: string[] = [
        `# Web Research: ${concept}`,
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        '## Search Queries',
        '',
        ...queries.map(q => `- ${q}`),
        '',
        '## Practical Takeaways',
        '',
        '- Identify the smallest playable loop before building supporting systems.',
        '- Prefer references for mechanics, pacing, camera, control feel, UI hierarchy, and asset scope.',
        '- Treat source code and assets as inspiration unless the license explicitly allows reuse.',
        '',
        '## Sources',
        ''
    ];

    if (results.length === 0) {
        lines.push('No web results were found.');
    }

    results.forEach((result, index) => {
        const summary = summaries.get(result.url);
        lines.push(`### ${index + 1}. ${result.title}`);
        lines.push('');
        lines.push(`- URL: ${result.url}`);
        lines.push(`- Query: ${result.query}`);
        if (result.snippet) lines.push(`- Search snippet: ${result.snippet}`);
        if (summary) {
            if (summary.description) lines.push(`- Page description: ${summary.description}`);
            lines.push(`- Saved text: ${toProjectRelative(projectRoot, summary.textFile)}`);
            if (summary.excerpts.length > 0) {
                lines.push('- Useful excerpts:');
                for (const excerpt of summary.excerpts) {
                    lines.push(`  - ${excerpt}`);
                }
            }
        }
        lines.push('');
    });

    const briefPath = path.join(folder, 'web_research.md');
    await fs.writeFile(briefPath, `${lines.join('\n')}\n`, 'utf-8');
    return briefPath;
}

async function writeGitHubReport(
    folder: string,
    query: string,
    repositories: GitHubRepository[],
    clonedRepositories: ClonedRepository[]
): Promise<string> {
    const lines: string[] = [
        `# GitHub Repository References: ${query}`,
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        'License note: do not copy code, assets, shaders, or data into the game project until the upstream license has been checked.',
        '',
        '## Repository Results',
        ''
    ];

    if (repositories.length === 0) {
        lines.push('No repositories were found.');
    }

    repositories.forEach((repo, index) => {
        lines.push(`### ${index + 1}. ${repo.fullName}`);
        lines.push('');
        lines.push(`- URL: ${repo.htmlUrl}`);
        lines.push(`- Description: ${repo.description || 'No description.'}`);
        lines.push(`- Stars: ${repo.stars}`);
        lines.push(`- Forks: ${repo.forks}`);
        lines.push(`- Language: ${repo.language || 'Unknown'}`);
        lines.push(`- License: ${repo.license}`);
        lines.push(`- Updated: ${repo.updatedAt || 'Unknown'}`);
        if (repo.topics.length > 0) lines.push(`- Topics: ${repo.topics.join(', ')}`);
        lines.push('');
    });

    if (clonedRepositories.length > 0) {
        lines.push('## Cloned Repositories');
        lines.push('');
        clonedRepositories.forEach(repo => {
            lines.push(`- ${repo.fullName}: ${repo.status} at ${repo.localPath}`);
            if (repo.message) lines.push(`  - ${repo.message}`);
        });
        lines.push('');
    }

    const reportPath = path.join(folder, 'github_repositories.md');
    await fs.writeFile(reportPath, `${lines.join('\n')}\n`, 'utf-8');
    return reportPath;
}

async function writeGameResearchOverview(
    folder: string,
    concept: string,
    webBriefPath: string,
    githubReportPath: string,
    clonedRepositories: ClonedRepository[]
): Promise<string> {
    const lines = [
        `# Game Reference Package: ${concept}`,
        '',
        `Generated: ${new Date().toISOString()}`,
        '',
        '## How To Use This Package',
        '',
        '- Read the web research brief before planning the MVP.',
        '- Use GitHub repositories for architecture and implementation patterns, not blind copy-paste.',
        '- Keep the first implementation focused on a visible, playable core loop.',
        '- Verify upstream licenses before reusing any external code or assets.',
        '',
        '## Files',
        ''
    ];

    if (webBriefPath) lines.push(`- Web research: ${path.basename(webBriefPath)}`);
    if (githubReportPath) lines.push(`- GitHub report: ${path.basename(githubReportPath)}`);
    if (clonedRepositories.length > 0) {
        lines.push('');
        lines.push('## Cloned Code References');
        lines.push('');
        clonedRepositories.forEach(repo => {
            lines.push(`- ${repo.fullName}: ${repo.localPath} (${repo.status})`);
        });
    }

    const overviewPath = path.join(folder, 'README.md');
    await fs.writeFile(overviewPath, `${lines.join('\n')}\n`, 'utf-8');
    return overviewPath;
}

async function appendReferenceIndex(
    referencesRoot: string,
    entry: { title: string; folder: string; files: string[] },
    projectRoot: string
): Promise<void> {
    const indexPath = path.join(referencesRoot, 'README.md');
    let existing = '';
    try {
        existing = await fs.readFile(indexPath, 'utf-8');
    } catch {
        existing = '# KsanaDock References\n\nAI-generated research briefs and external reference indexes.\n\n';
    }

    const line = [
        `## ${entry.title}`,
        '',
        `- Folder: ${toProjectRelative(projectRoot, entry.folder)}`,
        ...entry.files.map(file => `- File: ${toProjectRelative(projectRoot, file)}`),
        ''
    ].join('\n');

    await fs.writeFile(indexPath, `${existing.trimEnd()}\n\n${line}`, 'utf-8');
}

function stripHtml(input: string): string {
    return decodeHtmlEntities(input)
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function extractHtmlTitle(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    return match ? stripHtml(match[1] || '').trim() : '';
}

function extractMetaDescription(html: string): string {
    const match = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["'][^>]*>/i)
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["'][^>]*>/i);
    return match ? decodeHtmlEntities(match[1] || '').trim() : '';
}

function selectUsefulExcerpts(text: string, queryText: string, maxExcerpts: number): string[] {
    const keywords = Array.from(new Set(
        queryText
            .toLowerCase()
            .split(/[^a-z0-9\u4e00-\u9fff]+/i)
            .map(word => word.trim())
            .filter(word => word.length >= 3)
    ));

    const sentences = text
        .split(/(?<=[.!?\u3002\uff01\uff1f])\s+/)
        .map(sentence => sentence.trim())
        .filter(sentence => sentence.length >= 60 && sentence.length <= 360);

    const scored = sentences.map((sentence, index) => {
        const lower = sentence.toLowerCase();
        const score = keywords.reduce((acc, keyword) => acc + (lower.includes(keyword) ? 1 : 0), 0);
        return { sentence, score, index };
    }).filter(item => item.score > 0);

    scored.sort((a, b) => b.score - a.score || a.index - b.index);
    return scored.slice(0, maxExcerpts).map(item => item.sentence);
}

function decodeHtmlEntities(input: string): string {
    const named: Record<string, string> = {
        amp: '&',
        lt: '<',
        gt: '>',
        quot: '"',
        apos: "'",
        nbsp: ' '
    };

    return input.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (_, entity: string) => {
        if (entity.startsWith('#x')) {
            return String.fromCharCode(Number.parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith('#')) {
            return String.fromCharCode(Number.parseInt(entity.slice(1), 10));
        }
        return named[entity.toLowerCase()] || `&${entity};`;
    });
}

function normalizeQueries(queries: unknown[]): string[] {
    const seen = new Set<string>();
    const normalized: string[] = [];

    for (const item of queries) {
        const query = String(item || '').trim();
        if (!query || seen.has(query.toLowerCase())) continue;
        seen.add(query.toLowerCase());
        normalized.push(query);
    }

    return normalized;
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(numberValue)));
}

function slugify(input: string): string {
    const normalized = input
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 64);

    if (normalized) return normalized;
    return `game-${createHash('sha1').update(input).digest('hex').slice(0, 8)}`;
}

function sanitizePathSegment(input: string): string {
    return slugify(input).replace(/^-+|-+$/g, '') || 'reference';
}

function sanitizeOwnerRepoPart(input: string): string {
    return input.replace(/[^a-zA-Z0-9_.-]/g, '');
}

function normalizeUrlKey(url: string): string {
    try {
        const parsed = new URL(url);
        parsed.hash = '';
        return parsed.href.replace(/\/$/, '');
    } catch {
        return url;
    }
}

function isInside(parent: string, child: string): boolean {
    const relative = path.relative(path.resolve(parent), path.resolve(child));
    return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function toProjectRelative(projectRoot: string, fullPath: string): string {
    return path.relative(projectRoot, fullPath).replace(/\\/g, '/');
}
