import fs from 'fs';
import path from 'path';
import axios from 'axios';

/**
 * Virtual Try-On Service (VTON)
 *
 * TypeScript translation of the Python logic that calls Pinkyne's Gemini model
 * via a chat-completions-style HTTP API using two base64-encoded input images
 * (user + product).
 */
export class VtonService {
    private apiKey: string;
    private baseUrl: string;

    constructor(apiKey?: string, baseUrl?: string) {
        const key = apiKey || process.env.PINKYNE_API_KEY || process.env.OPENAI_API_KEY;
        if (!key) {
            throw new Error('PINKYNE_API_KEY (or OPENAI_API_KEY) environment variable is not set');
        }

        this.apiKey = key;
        this.baseUrl = baseUrl || process.env.PINKYNE_API_BASE_URL || 'https://api.pinkyne.com/v1';
    }

    /**
     * Generates a virtual try-on image using a user image and a product image, plus a text prompt.
     *
     * @param userImagePath - Path to the local user image file
     * @param productImagePath - Path to the local product/clothing image file
     * @param outputImagePath - Path where the generated image will be saved
     * @param textPrompt - Textual instruction / style prompt for the VTON model
     * @returns The outputImagePath for convenience
     */
    async generateTryOn(
        userImagePath: string,
        productImagePath: string,
        outputImagePath: string,
        textPrompt: string,
    ): Promise<string> {
        // Step 1: Read and encode the user image as base64
        if (!fs.existsSync(userImagePath)) {
            throw new Error(`User image not found at path: ${userImagePath}`);
        }
        const userBuffer = fs.readFileSync(userImagePath);
        const userBase64 = userBuffer.toString('base64');

        // Step 2: Read and encode the product image as base64
        if (!fs.existsSync(productImagePath)) {
            throw new Error(`Product image not found at path: ${productImagePath}`);
        }
        const productBuffer = fs.readFileSync(productImagePath);
        const productBase64 = productBuffer.toString('base64');

        // Step 3: Construct payload matching the Python Gemini multimodal format
        const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

        const payload = {
            model: 'gemini-2.5-flash-image-preview',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: textPrompt } as any,
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${userBase64}` },
                        } as any,
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${productBase64}` },
                        } as any,
                    ],
                },
            ],
            metadata: { image_config: { aspect_ratio: '9:16' } },
            max_tokens: 500,
        };

        const response = await axios.post(endpoint, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
        });

        // Debug: log raw API response to inspect structure
        console.log('🔍 RAW API RESPONSE:', JSON.stringify(response.data, null, 2));

        // Step 5: Extract base64 image data from the response
        const imageBase64 = this.extractBase64FromResponse(response.data);
        if (!imageBase64) {
            throw new Error(
                `Failed to extract base64 image data from VTON response. Raw snippet: ${JSON.stringify(response.data).slice(0, 200)}`
            );
        }

        // Ensure output directory exists
        const outDir = path.dirname(outputImagePath);
        if (!fs.existsSync(outDir)) {
            fs.mkdirSync(outDir, { recursive: true });
        }

        // Save the image to disk
        const outputBuffer = Buffer.from(imageBase64, 'base64');
        fs.writeFileSync(outputImagePath, outputBuffer);

        return outputImagePath;
    }

    /**
     * Attempts to extract a base64-encoded image string from the chat completion response.
     * Supports multiple possible shapes of the response for robustness.
     */
    /* eslint-disable @typescript-eslint/no-explicit-any */
    private extractBase64FromResponse(response: any): string | null {
        if (!response || !response.choices || response.choices.length === 0) {
            return null;
        }

        const message = response.choices[0]?.message;
        if (!message) return null;

        const content = message.content;

        const extractFromText = (text: string): string | null => {
            if (!text) return null;

            // Remove backticks and known labels like ```json or ```base64
            let cleaned = text.replace(/`/g, '').trim();
            cleaned = cleaned.replace(/^json/i, '').replace(/^base64/i, '').trim();

            // 1) Markdown image syntax: ![](data:image/...)
            const markdownMatch = cleaned.match(/!\[.*?\]\((data:image\/.*?;base64,.*?)\)/);
            if (markdownMatch && markdownMatch[1]) {
                const dataUrl = markdownMatch[1];
                const parts = dataUrl.split(',');
                return parts.length > 1 ? parts[1] : null;
            }

            // 2) Plain data URL
            if (cleaned.startsWith('data:image')) {
                const parts = cleaned.split(',');
                return parts.length > 1 ? parts[1] : null;
            }

            // 3) Raw base64 fallback
            if (/^[A-Za-z0-9+/=]+$/.test(cleaned) && cleaned.length > 500) {
                return cleaned;
            }

            // 4) Fallback: search for any data:image pattern in the text
            const anyDataUrl = cleaned.match(/(data:image\/[^;]+;base64,[^"\s\)]+)/);
            if (anyDataUrl && anyDataUrl[1]) {
                const parts = anyDataUrl[1].split(',');
                return parts.length > 1 ? parts[1] : null;
            }

            return null;
        };

        // Case 1: content is an array of parts (OpenAI-style content array)
        if (Array.isArray(content)) {
            for (const part of content) {
                if (part.type === 'image_url' && part.image_url?.url) {
                    const url: string = part.image_url.url;
                    const candidate = extractFromText(url);
                    if (candidate) {
                        return candidate;
                    }
                }
                if (part.type === 'text' && typeof part.text === 'string') {
                    const candidate = extractFromText(part.text);
                    if (candidate) {
                        return candidate;
                    }
                }
            }
        }

        // Case 2: older style string content
        if (typeof content === 'string') {
            return extractFromText(content);
        }

        return null;
    }
    /* eslint-enable @typescript-eslint/no-explicit-any */
}



