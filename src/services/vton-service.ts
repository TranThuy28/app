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
     * @returns Base64-encoded result image
     */
    async generateVton(
        userImageBase64: string,
        productUrls: string[],
    ): Promise<{ success: boolean; image?: string; type?: 'vton' | 'composite'; warning?: string; error?: string }> {
        // Step A: Create outfit board (collage)
        console.log(`🎨 Creating outfit board from ${productUrls.length} product images...`);
        const outfitBoardBuffer = await this.createOutfitComposite(productUrls);
        const outfitBoardBase64 = outfitBoardBuffer.toString('base64');

        // Step B: Construct simple multimodal prompt for Gemini 2.5 Flash
        const prompt = `You are an expert AI fashion photographer and virtual stylist, specializing in hyper-realistic virtual try-on technology.

INPUTS:
- Image 1 (Reference User): Provides the target person's face, hair, exact body pose, and the background environment.
- Image 2 (Outfit Flat-Lay): Provides the complete set of clothing and accessories that must be worn.

PRIMARY TASK:
Generate a photorealistic, full-body photograph of the specific person from Image 1, now wearing EVERY single item depicted in the outfit flat-lay of Image 2.

STRICT CONSTRAINTS & EXECUTION GUIDELINES:

1.  **IDENTITY & POSE LOCK (CRITICAL):**
    * The face, facial features, hair style, hair color, skin tone, and body proportions MUST be identical to Image 1. Do not swap faces or alter the person's identity.
    * The exact body pose from Image 1 MUST be maintained. The new clothes must conform to this specific pose.

2.  **COMPLETE OUTFIT TRANSFER:**
    * **Mandatory Inclusion:** Every item visible in Image 2 (top, bottom, shoes, bag, hats, accessories) MUST be present in the final image. No missing items.
    * **Realistic Replacement:** The user's original clothes in Image 1 must be completely removed and replaced by the items in Image 2.

3.  **REALISTIC DRAPE & TEXTURE:**
    * Clothes must NOT look like flat stickers. They must drape realistically over the user's body shape, showing realistic fabric folds, wrinkles, tension based on the pose, and accurate material textures (e.g., denim looks like denim, silk looks silky).
    * Lighting on the new clothes must match the lighting in the original background of Image 1.

4.  **ITEM PLACEMENT & COMPOSITION:**
    * **Full-Body Shot:** The final image must be a full-body view to ensure shoes are clearly visible on the feet.
    * **Bags & Accessories:** Bags must be held naturally in the hand or slung over the shoulder, consistent with the pose in Image 1. Never have items floating near the body.
    * **Layering:** If Image 2 contains layers (e.g., a jacket over a shirt), they must be layered correctly on the user.

5.  **ENVIRONMENT INTEGRATION:**
    * Keep the background and environmental lighting exactly the same as Image 1 to ensure the result looks like a single, cohesive photograph.

**NEGATIVE CONSTRAINTS (What to avoid):**
(distorted face), (changed identity), (missing shoes), (missing bag), (floating clothes), (flat textures), (cartoonish), (blurry items), (original clothes visible underneath).`;

        // Step C: Call Pinkyne API
        const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

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



