import { log } from 'crawlee';
import axios from 'axios';
import type { ProductDetails } from '../scraper.ts';

/**
 * Enriched product data interface matching the strict schema
 */
export interface EnrichedProduct {
    id: string; // generated slug
    title: string;
    brand: string;
    product_url: string;
    image_url: string; // The high-res local path or URL
    category_main: 'outerwear' | 'top' | 'bottom' | 'dress' | 'shoes' | 'accessory' | 'set';
    category_sub: string; // e.g., "long_hooded_jacket", "pencil_skirt"
    category_folder: 'casual' | 'hanging' | 'office' | 'party'; // Occasion-based classification
    gender: 'womens';
    age_group: 'adult'; // Target 20-35
    description: string; // Generated from bullet points
    material: string[];
    color: string;
    pattern: string;
    fit: string; // e.g., "regular", "slim", "oversized"
    silhouette: string; // e.g., "longline", "a-line"
    length: string;
    season: string[];
    style_tags: string[]; // e.g., ["office", "chic", "streetwear"]
    occasion_tags: string[]; // e.g., ["work", "party", "daily"]
    sizes: string[]; // Scraped sizes
    price: number;
    currency: 'usd' | 'vnd';
    is_set: boolean; // true if it's a 2-piece set
    productDetails: Record<string, string>; // Raw product details from web crawl
    aboutThisItem: string[]; // Raw "About this item" bullets from web crawl
}

/**
 * Extracts a JSON object from an LLM string response.
 * - Supports fenced code blocks ```json ... ``` or ``` ... ```.
 * - Trims whitespace.
 * - Attempts to slice from first '{' to last '}' to ignore extra text.
 */
function extractJson(content: string): any {
    // 1. Try to extract from markdown code block first
    const jsonMatch =
        content.match(/```json\s*([\s\S]*?)\s*```/i) ||
        content.match(/```\s*([\s\S]*?)\s*```/i);

    let jsonString = jsonMatch ? jsonMatch[1] : content;

    // 2. Trim whitespace
    jsonString = jsonString.trim();

    // 3. Try to isolate the JSON object between first '{' and last '}'
    const firstBrace = jsonString.indexOf('{');
    const lastBrace = jsonString.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
        jsonString = jsonString.slice(firstBrace, lastBrace + 1);
    }

    // 4. Parse JSON (will throw if invalid)
    return JSON.parse(jsonString);
}

/**
 * Generates a URL-friendly slug from a string
 */
const generateSlug = (text: string): string => {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .substring(0, 100);
};


/**
 * Extracts brand from title (usually first word or two before "Womens" or "Women's")
 */
const extractBrand = (title: string): string => {
    const brandPatterns = [
        /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+(?:Womens|Women's|Women)/i,
        /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\s+/,
    ];

    for (const pattern of brandPatterns) {
        const match = title.match(pattern);
        if (match && match[1]) {
            return match[1].trim();
        }
    }

    // Fallback: first word
    const firstWord = title.split(' ')[0];
    return firstWord || 'Unknown';
};

/**
 * Infers category_main and category_sub from title
 */
const inferCategory = (title: string): { category_main: EnrichedProduct['category_main']; category_sub: string } => {
    const lowerTitle = title.toLowerCase();

    if (lowerTitle.includes('dress')) {
        return { category_main: 'dress', category_sub: 'dress' };
    }
    if (lowerTitle.includes('jacket') || lowerTitle.includes('blazer') || lowerTitle.includes('coat')) {
        return { category_main: 'outerwear', category_sub: 'jacket' };
    }
    if (lowerTitle.includes('shirt') || lowerTitle.includes('blouse') || lowerTitle.includes('top') || lowerTitle.includes('tee')) {
        return { category_main: 'top', category_sub: 'top' };
    }
    if (lowerTitle.includes('pants') || lowerTitle.includes('trousers') || lowerTitle.includes('skirt')) {
        return { category_main: 'bottom', category_sub: lowerTitle.includes('skirt') ? 'skirt' : 'pants' };
    }
    if (lowerTitle.includes('shoes') || lowerTitle.includes('heels') || lowerTitle.includes('pumps') || lowerTitle.includes('sneakers')) {
        return { category_main: 'shoes', category_sub: 'shoes' };
    }
    if (lowerTitle.includes('set') || lowerTitle.includes('2-piece') || lowerTitle.includes('outfit')) {
        return { category_main: 'set', category_sub: 'set' };
    }

    return { category_main: 'top', category_sub: 'unknown' };
};

/**
 * Calls Pinkyne/Gemini LLM to enrich a single product.
 * Uses axios to send the raw product JSON and returns a cleaned, enriched product.
 */
export const enrichProduct = async (rawProduct: ProductDetails & { product_url?: string }): Promise<EnrichedProduct> => {
    const apiKey = process.env.PINKYNE_API_KEY;
    if (!apiKey) {
        throw new Error('PINKYNE_API_KEY environment variable is not set');
    }

    const baseUrl = 'https://api.pinkyne.com/v1';

    const schemaDescription = `
You must read the product details and aboutThisItem to fill the other fields; return ONLY valid JSON matching this TypeScript schema:
{
  "id": "url-friendly-slug-from-title",
  "title": "exact product title",
  "brand": "brand name",
  "product_url": "original Amazon URL if available",
  "image_url": "first image URL from the list",
  "category_main": "one of: outerwear, top, bottom, dress, shoes, accessory, set",
  "category_sub": "specific subcategory in snake_case (e.g., long_hooded_jacket, pencil_skirt)",
  "category_folder": "hanging",
  "gender": "womens",
  "age_group": "adult",
  "description": "short but rich marketing description based on aboutThisItem (max 30-40 words)",
  "material": ["array of materials in lowercase"],
  "color": "primary color name in lowercase",
  "pattern": "pattern type (e.g., solid, striped, floral, plaid) or 'none'",
  "fit": "fit type (regular, slim, oversized, relaxed, fitted)",
  "silhouette": "silhouette description (e.g., longline, a-line, straight, fitted)",
  "length": "length description (e.g., short, midi, long, cropped)",
  "season": ["array of applicable seasons: spring, summer, fall, winter"],
  "style_tags": ["array of style descriptors like office, chic, streetwear, casual, elegant"],
  "occasion_tags": ["array of occasions like work, party, daily, formal, casual, date"],
  "sizes": ["array of available sizes if mentioned"],
  "price": number,
  "currency": "usd",
  "is_set": boolean,
  "productDetails": { "key": "value", "...": "..." },
  "aboutThisItem": ["bullet1", "bullet2", "..."]
}

Rules:
- Fix typos and normalize material/color names.
- Use aboutThisItem bullets to build a concise description (max 30-40 words, no fluff).
- Choose EXACTLY ONE of [ office,party, casual, hanging] for category_folder.
- Return ONLY raw JSON, no markdown, no explanation.
`;

    const prompt = `
You are an AI Data Cleaner. I will give you a raw product JSON from Amazon.
Please correct typos, standardise fields (material, color), generate a short description based on "aboutThisItem",
and classify it into one of: [ "office", "party", "casual", "hanging"].

${schemaDescription}

Raw product JSON:
${JSON.stringify(rawProduct, null, 2)}
`;

    try {
        const response = await axios.post(
            `${baseUrl}/chat/completions`,
            {
                model: 'gpt-4.1-mini', // or any suitable model on Pinkyne
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an AI Data Cleaner for fashion products. ' +
                            'Always return ONLY valid JSON, no extra explanation. ' +
                            'Keep the generated description concise (max 30-40 words).',
                    },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.2,
                max_tokens: 2000,
                stream: false,
            },
            {
                headers: {
                    Authorization: `Bearer ${apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 60000,
            }
        );

        const content: string | undefined =
            response.data?.choices?.[0]?.message?.content ?? response.data?.choices?.[0]?.message;

        if (!content) {
            throw new Error('Empty response from enrichment API');
        }

        let parsed: any;
        try {
            parsed = extractJson(content);
        } catch (err) {
            throw new Error(
                `Failed to parse enrichment JSON: ${(err as Error).message}\nRaw content: ${content.slice(
                    0,
                    800,
                )}`,
            );
        }

        // Fallbacks and normalization
        if (!parsed.id) {
            parsed.id = generateSlug(rawProduct.title);
        }
        if (!parsed.title) {
            parsed.title = rawProduct.title;
        }
        if (!parsed.product_url) {
            parsed.product_url = rawProduct.product_url ?? '';
        }
        if (!parsed.image_url) {
            parsed.image_url = rawProduct.imageUrls?.[0] ?? '';
        }
        if (!parsed.category_main || !parsed.category_sub) {
            const inferred = inferCategory(rawProduct.title);
            parsed.category_main = parsed.category_main || inferred.category_main;
            parsed.category_sub = parsed.category_sub || inferred.category_sub;
        }

        const validFolders = ['casual', 'office', 'party', 'hanging'] as const;
        if (!parsed.category_folder || !validFolders.includes(parsed.category_folder)) {
            // Simple fallback: default to casual
            parsed.category_folder = 'casual';
        }

        // Ensure arrays
        parsed.material = Array.isArray(parsed.material) ? parsed.material : [];
        parsed.season = Array.isArray(parsed.season) ? parsed.season : [];
        parsed.style_tags = Array.isArray(parsed.style_tags) ? parsed.style_tags : [];
        parsed.occasion_tags = Array.isArray(parsed.occasion_tags) ? parsed.occasion_tags : [];
        parsed.sizes = Array.isArray(parsed.sizes) ? parsed.sizes : [];

        // Ensure numeric fields
        parsed.price = typeof parsed.price === 'number' ? parsed.price : rawProduct.price;
        parsed.currency = parsed.currency || 'usd';
        parsed.is_set = Boolean(parsed.is_set);

        // Always carry over raw details
        parsed.productDetails = rawProduct.productDetails ?? {};
        parsed.aboutThisItem = rawProduct.aboutThisItem ?? [];

        const enriched: EnrichedProduct = parsed as EnrichedProduct;

        log.info('Product data enriched (LLM)', {
            id: enriched.id,
            category: enriched.category_main,
            category_folder: enriched.category_folder,
            brand: enriched.brand,
        });

        return enriched;
    } catch (error) {
        if (axios.isAxiosError(error)) {
            log.error('Enrichment API request failed', {
                status: error.response?.status,
                data: error.response?.data,
                message: error.message,
            });
        } else {
            log.error('Enrichment failed', {
                error: error instanceof Error ? error.message : String(error),
            });
        }
        throw error;
    }
};
