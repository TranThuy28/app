import fs from 'fs';
import path from 'path';
import axios from 'axios';
import sharp from 'sharp';

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
     * Downloads an image from a URL and returns it as a Buffer
     */
    private async downloadImage(url: string): Promise<Buffer> {
        try {
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            return Buffer.from(response.data);
        } catch (error) {
            console.error(`Failed to download image from ${url}:`, error);
            throw new Error(`Failed to download image: ${url}`);
        }
    }

    /**
     * Creates a simple outfit board (collage) from multiple product image URLs.
     * Uses safe boxing to ensure all images fit within fixed-size cells without overflow.
     */
    private async createOutfitComposite(imageUrls: string[]): Promise<Buffer> {
        if (imageUrls.length === 0) {
            throw new Error('No image URLs provided for composite');
        }

        // Download all images
        const imageBuffers = await Promise.all(
            imageUrls.map(url => this.downloadImage(url))
        );

        // Determine grid layout
        const itemCount = Math.min(imageUrls.length, 6); // Max 6 items
        let rows: number;
        let cols: number;

        if (itemCount === 1) {
            rows = 1;
            cols = 1;
        } else if (itemCount === 2) {
            rows = 1;
            cols = 2;
        } else if (itemCount <= 4) {
            rows = 2;
            cols = 2; // 2x2 grid
        } else {
            rows = 2;
            cols = 3; // 2x3 grid for 5-6 items
        }

        // Safe boxing: fixed box size ensures no overflow
        const boxSize = 512;
        const padding = 20;
        const cellWidth = boxSize + padding * 2;
        const cellHeight = boxSize + padding * 2;

        // Process each image: resize to fit within square box (safe boxing)
        const processedImages = await Promise.all(
            imageBuffers.slice(0, itemCount).map(async (buffer, index) => {
                // Resize to fit within square box - ensures image never exceeds boxSize x boxSize
                const resizedBuffer = await sharp(buffer)
                    .resize(boxSize, boxSize, {
                        fit: 'contain', // Ensures image fits inside box without cropping
                        background: { r: 255, g: 255, b: 255, alpha: 1 }, // Fills empty space with white
                    })
                    .toBuffer();

                // Calculate position in grid (centered within cell)
                const row = Math.floor(index / cols);
                const col = index % cols;
                const top = row * cellHeight + padding;
                const left = col * cellWidth + padding;

                return {
                    input: resizedBuffer,
                    top: Math.round(top),
                    left: Math.round(left),
                };
            })
        );

        // Create canvas with white background
        const canvasWidth = cols * cellWidth;
        const canvasHeight = rows * cellHeight;

        const composite = sharp({
            create: {
                width: canvasWidth,
                height: canvasHeight,
                channels: 3,
                background: { r: 255, g: 255, b: 255 },
            },
        });

        // Composite all images onto the canvas
        const finalBuffer = await composite
            .composite(processedImages)
            .jpeg({ quality: 85 })
            .toBuffer();

        return finalBuffer;
    }

    /**
     * Generates a virtual try-on image using a user image (base64) and multiple product image URLs.
     * Creates an outfit board (collage) and sends to Gemini 2.5 Flash for generation.
     *
     * @param userImageBase64 - Base64-encoded user image
     * @param productUrls - Array of product image URLs to composite
     * @param userProfile - Optional user profile containing body measurements
     * @param productDetails - Optional manifest details of items to extract (e.g., category/title)
     * @returns Base64-encoded result image
     */
    async generateVton(
        userImageBase64: string,
        productUrls: string[],
        userProfile: any,
        productDetails: string[] = [],
    ): Promise<{ success: boolean; image?: string; type?: 'vton' | 'composite'; warning?: string; error?: string }> {
        // Step A: Create outfit board (collage)
        console.log(`🎨 Creating outfit board from ${productUrls.length} product images...`);
        const outfitBoardBuffer = await this.createOutfitComposite(productUrls);
        const outfitBoardBase64 = outfitBoardBuffer.toString('base64');

        // Step B: Construct multimodal prompt for Gemini 2.5 Flash with body measurements
        const bodyContext = `
USER MEASUREMENTS:
- Height: ${userProfile?.height_cm ?? 'unknown'}cm
- Weight: ${userProfile?.weight_kg ?? 'unknown'}kg
- Body Shape: ${userProfile?.body_shape ?? 'unknown'}
- Distinctive Features: ${(userProfile?.body_features || []).join(', ')}
`;

        const prompt = `
ROLE: You are an Elite AI Fashion Photographer and Digital Artist. You specialize in taking a person from a reference photo and dressing them in a new outfit with hyper-realistic lighting and physics.

INPUTS:
- Image 1 (The Muse): The target person. Reference for face, hair, pose, skin tone, and lighting.
- Image 2 (The Wardrobe): A collection of clothing items to be worn.

CONTEXT - BODY SPECS:
- Height: ${userProfile?.height_cm || 'Standard'} cm
- Weight: ${userProfile?.weight_kg || 'Standard'} kg
- Shape: ${userProfile?.body_shape || 'Standard'}
*(Note: If these metrics conflict significantly with the visual evidence in Image 1, prioritize the visual proportions of Image 1 to maintain realism).*

TASK: Create a seamless, photorealistic fashion editorial shot of "The Muse" wearing "The Wardrobe".

GUIDELINES FOR CLOTHING TRANSFER (SMART FOCUS):
1.  **Identify the Primary Item:** When looking at a product image in "The Wardrobe", identify the *main item* being sold (e.g., in a photo of Pants + Shoes, the Pants are the product).
2.  **Ignore Distractions:**
    * If a photo shows Pants but has Shoes -> **Ignore the shoes** (unless there is no other shoe image). Use the user's feet or specific shoe product if provided.
    * If a photo shows a Top but has a model's face/glasses -> **Ignore the face/glasses**. Only take the fabric/design of the Top.
3.  **Fabric Physics:**
    * Do not "paste" the image. **Re-draw** the garment wrapping around the user's body.
    * Apply proper lighting, shadows, and wrinkles matching the Muse's pose.

STRICT CONSTRAINTS:
1.  **Identity Lock:** The face and hair MUST match Image 1 exactly.
2.  **Natural Fit:** The clothes must fit the body described in the visual input of Image 1 (adjusted slightly for the weight/height data provided).
3.  **No Hallucinations:** Do not add accessories (hats, glasses, jewelry) that are not in the source images.

NEGATIVE PROMPT:
(collage style), (paper cutout), (distorted face), (changing identity), (extra shoes), (floating bags), (bad anatomy), (blurry), (low quality).

OUTPUT FORMAT REQUIREMENT (STRICT):
1. **NO CONVERSATIONAL TEXT:** Do NOT output "Here is the image", "I created this", or any introduction.
2. **IMAGE ONLY:** Your response must contain ONLY the generated image (or the markdown/link to it).
3. **SILENCE:** If you cannot generate the image, return a JSON error {"error": "reason"}. Do not chat.
`;

        // Step C: Call Pinkyne API
        const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;
        console.log('prompt', prompt);
        const payload = {
            model: 'gemini-2.5-flash-image-preview',
            messages: [
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt } as any,
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${userImageBase64}` },
                        } as any,
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${outfitBoardBase64}` },
                        } as any,
                    ],
                },
            ],
            metadata: { image_config: { aspect_ratio: '9:16' } },
            max_tokens: 500,
        };

        try {
        console.log('🤖 Sending VTON request to Pinkyne API...');
        const response = await axios.post(endpoint, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
                timeout: 60000, // 60 seconds
        });

            // Extract base64 image data from the response
        const imageBase64 = this.extractBase64FromResponse(response.data);
        if (!imageBase64) {
            throw new Error(
                `Failed to extract base64 image data from VTON response. Raw snippet: ${JSON.stringify(response.data).slice(0, 200)}`
            );
        }
            console.log('image gen success');

            return { success: true, image: imageBase64, type: 'vton' };
        } catch (error) {
            console.error('❌ VTON failed, returning outfit board fallback...', {
                error: error instanceof Error ? error.message : String(error),
            });

            // Return the outfit board as fallback
            return {
                success: true,
                image: outfitBoardBase64,
                type: 'composite',
                warning: 'AI busy, showing outfit preview.',
            };
        }
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



