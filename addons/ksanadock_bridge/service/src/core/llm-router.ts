import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initial load
dotenv.config({ path: path.join(__dirname, '../../.env') });

export interface LLMRoute {
    url: string;
    apiKey: string;
    headers: Record<string, string>;
}

export class LLMRouter {
    static getRoute(provider: string, customApiKey?: string): LLMRoute {
        let url = '';
        let apiKey = '';
        let headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        };

        const providerLower = (provider || '').toLowerCase();

        switch (providerLower) {
            case 'siliconflow':
                url = 'https://api.siliconflow.cn/v1/chat/completions';
                apiKey = customApiKey || process.env.SILICONFLOW_API_KEY || '';
                break;

            case 'xiaomi':
                apiKey = (customApiKey || process.env.XIAOMI_API_KEY || '').trim();
                const isTokenPlan = apiKey.startsWith('tp-');
                url = isTokenPlan
                    ? 'https://token-plan-cn.xiaomimimo.com/v1/chat/completions'
                    : 'https://api.xiaomimimo.com/v1/chat/completions';
                break;

            case 'zai':
                url = 'https://api.z.ai/api/paas/v4/chat/completions';
                // Use absolute path for override to ensure it works regardless of CWD
                dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });
                apiKey = (customApiKey || process.env.ZAI_API_KEY || '').trim();
                headers['Accept-Language'] = 'en-US,en';
                break;

            case 'openrouter':
            default:
                url = 'https://openrouter.ai/api/v1/chat/completions';
                apiKey = customApiKey || process.env.OPENROUTER_API_KEY || '';
                headers['HTTP-Referer'] = 'https://github.com/ksanadock/godotmaker';
                headers['X-Title'] = 'KsanaDock Loop Engine';
                break;
        }

        return {
            url,
            apiKey: apiKey.trim(),
            headers: {
                ...headers,
                'Authorization': `Bearer ${apiKey.trim()}`
            }
        };
    }
}
