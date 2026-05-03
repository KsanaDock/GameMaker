import * as fs from 'fs/promises';
import * as path from 'path';
import axios from 'axios';
import * as dotenv from 'dotenv';

dotenv.config();

export function registerVisionTools(registry: any, projectRoot: string) {
    registry.register({
        name: 'analyze_image',
        description: 'Analyze an image using a Vision API. Use this to understand the content of an image, infer spritesheet grid dimensions (hframes, vframes), or identify objects. Provide a specific query.',
        parameters: {
            type: 'object',
            properties: {
                imagePath: { type: 'string', description: 'File path of the image relative to project root (e.g. "assets/player.png")' },
                query: { type: 'string', description: 'What do you want to know about the image? Be specific.' }
            },
            required: ['imagePath', 'query']
        },
        handler: async (args: any) => {
            const { imagePath, query } = args;
            const fullPath = path.resolve(projectRoot, imagePath);
            
            if (!fullPath.startsWith(projectRoot)) {
                return { error: 'Permission denied: path outside project root' };
            }

            try {
                // Determine mime type based on extension
                const ext = path.extname(fullPath).toLowerCase();
                let mimeType = 'image/png';
                if (ext === '.jpg' || ext === '.jpeg') mimeType = 'image/jpeg';
                else if (ext === '.webp') mimeType = 'image/webp';
                else if (ext === '.gif') mimeType = 'image/gif';

                // Read file to Base64
                const fileBuffer = await fs.readFile(fullPath);
                const base64Image = fileBuffer.toString('base64');
                const dataUrl = `data:${mimeType};base64,${base64Image}`;

                // Setup API call
                const provider = process.env.LLM_PROVIDER || 'openrouter';
                let apiKey = process.env.OPENROUTER_API_KEY;
                if (provider === 'siliconflow') {
                    apiKey = process.env.SILICONFLOW_API_KEY;
                }
                
                const model = process.env.MODEL || 'google/gemini-3-flash-preview';
                
                let url = 'https://openrouter.ai/api/v1/chat/completions';
                if (provider === 'siliconflow') {
                    url = 'https://api.siliconflow.cn/v1/chat/completions';
                }

                if (!apiKey) {
                    return { error: 'API Key not found in environment variables.' };
                }

                console.log(`[Vision Tool] Analyzing ${imagePath} with model ${model}...`);

                const messages = [
                    {
                        role: "user",
                        content: [
                            { type: "text", text: query },
                            {
                                type: "image_url",
                                image_url: {
                                    url: dataUrl
                                }
                            }
                        ]
                    }
                ];

                const res = await axios.post(
                    url,
                    {
                        model: model,
                        messages: messages
                    },
                    {
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'HTTP-Referer': 'https://github.com/ksanadock/ksanadock',
                            'X-Title': 'KsanaDock Vision Tool',
                            'Content-Type': 'application/json'
                        },
                        timeout: 60000 // 60s timeout for vision
                    }
                );

                if (res.data && res.data.choices && res.data.choices.length > 0) {
                    return { result: res.data.choices[0].message.content };
                } else {
                    return { error: "No response from Vision API." };
                }

            } catch (e: any) {
                console.error("[Vision Tool Error]", e.response ? e.response.data : e.message);
                const errorMsg = e.response && e.response.data && e.response.data.error ? JSON.stringify(e.response.data.error) : e.message;
                return { error: errorMsg };
            }
        }
    });
}
