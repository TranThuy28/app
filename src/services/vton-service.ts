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
     * Creates a composite image from multiple product image URLs.
     * Arranges them in a smart grid layout that preserves aspect ratios.
     */
    private async createOutfitComposite(imageUrls: string[]): Promise<Buffer> {
        if (imageUrls.length === 0) {
            throw new Error('No image URLs provided for composite');
        }

        // Download all images
        const imageBuffers = await Promise.all(
            imageUrls.map(url => this.downloadImage(url))
        );

        // Determine grid layout based on item count
        const itemCount = Math.min(imageUrls.length, 6); // Max 6 items
        let rows: number;
        let cols: number;

        if (itemCount === 1) {
            rows = 1;
            cols = 1;
        } else if (itemCount === 2) {
            rows = 1;
            cols = 2; // Side-by-side
        } else if (itemCount <= 4) {
            rows = 2;
            cols = 2; // 2x2 grid
        } else {
            // 5-6 items: 2 rows, 3 columns
            rows = 2;
            cols = 3;
        }

        // Fixed canvas size (800x800 square)
        const canvasWidth = 800;
        const canvasHeight = 800;

        // Calculate cell dimensions
        const cellWidth = canvasWidth / cols;
        const cellHeight = canvasHeight / rows;

        // Process each image to fit within its cell while preserving aspect ratio
        const processedImages = await Promise.all(
            imageBuffers.slice(0, itemCount).map(async (buffer, index) => {
                // Resize image to fit within cell dimensions, preserving aspect ratio
                const resizedBuffer = await sharp(buffer)
                    .resize(cellWidth, cellHeight, {
                        fit: 'contain',
                        background: { r: 255, g: 255, b: 255, alpha: 1 },
                    })
                    .toBuffer();

                // Calculate position in grid
                const row = Math.floor(index / cols);
                const col = index % cols;
                const top = row * cellHeight;
                const left = col * cellWidth;

                return {
                    input: resizedBuffer,
                    top: Math.round(top),
                    left: Math.round(left),
                };
            })
        );

        // Create composite canvas
        const composite = sharp({
            create: {
                width: canvasWidth,
                height: canvasHeight,
                channels: 3,
                background: { r: 255, g: 255, b: 255 },
            },
        });

        // Composite all images onto the canvas
        const finalBuffer = await composite.composite(processedImages).jpeg().toBuffer();
        return finalBuffer;
    }

    /**
     * Generates a virtual try-on image using a user image (base64) and multiple product image URLs.
     * Creates a composite of all product images and sends to VTON API.
     *
     * @param userImageBase64 - Base64-encoded user image
     * @param productUrls - Array of product image URLs to composite
     * @returns Base64-encoded result image
     */
    async generateVton(userImageBase64: string, productUrls: string[]): Promise<string> {
        // Step 1: Create composite outfit image
        console.log(`🎨 Creating outfit composite from ${productUrls.length} product images...`);
        const outfitCompositeBuffer = await this.createOutfitComposite(productUrls);
        const garmentBase64 = outfitCompositeBuffer.toString('base64');

        // Step 2: Construct the strict identity-preserving prompt
        const systemPrompt = `

TASK: Photorealistic Virtual Try-On / Image Editing.

BASE IMAGE: The user provided in the first image.

REFERENCE CLOTHING: The composite outfit provided in the second image.



INSTRUCTIONS:

1.  **Strict Identity Preservation:** You MUST preserve the user's face, hair, head shape, skin tone, and body pose EXACTLY as they appear in the Base Image. Do NOT generate a new face. Do NOT apply heavy beautification filters that alter features.

2.  **Target Action:** Only replace the user's current clothing with the items visible in the Reference Clothing image.

3.  **Outfit Mapping:**

    -   If the reference is a Dress -> Replace the user's top and bottom.

    -   If the reference is Top + Bottom -> Replace accordingly.

    -   If the reference includes a Bag -> Composite the bag naturally over the shoulder or in hand (if pose allows), otherwise place it near the user.

4.  **Background:** Keep the original background of the Base Image as much as possible.



NEGATIVE PROMPT (What to avoid):

(changing face:1.5), (changing hair:1.3), (new person), (cartoon), (illustration), (floating clothes), (distorted face), (extra limbs), ( mannequins), (flat lay next to person).



OUTPUT REQUIREMENT:

Return a single photorealistic image of the ORIGINAL USER wearing the NEW OUTFIT.

`;

        // Step 3: Call Pinkyne API
        const endpoint = `${this.baseUrl.replace(/\/+$/, '')}/chat/completions`;

        const payload = {
            model: 'gemini-2.5-flash-image-preview',
            messages: [
                {
                    role: 'system',
                    content: 'You are a professional virtual try-on AI. Your primary responsibility is to preserve the user\'s identity (face, hair, body shape, pose) EXACTLY as shown in the base image. Only replace clothing items, never alter the person\'s appearance.',
                },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: systemPrompt } as any,
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${userImageBase64}` },
                        } as any,
                        {
                            type: 'image_url',
                            image_url: { url: `data:image/jpeg;base64,${garmentBase64}` },
                        } as any,
                    ],
                },
            ],
            metadata: { image_config: { aspect_ratio: '9:16' } },
            max_tokens: 500,
        };

        console.log('🤖 Sending VTON request to Pinkyne API...');
        const response = await axios.post(endpoint, payload, {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${this.apiKey}`,
            },
        });

        // Step 4: Extract base64 image data from the response
        const imageBase64 = this.extractBase64FromResponse(response.data);
        if (!imageBase64) {
            throw new Error(
                `Failed to extract base64 image data from VTON response. Raw snippet: ${JSON.stringify(response.data).slice(0, 200)}`
            );
        }

        return imageBase64;
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



