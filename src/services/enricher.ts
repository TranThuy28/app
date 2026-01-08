import { log } from 'crawlee';
import axios from 'axios';
import type { ProductDetails } from '../scraper.ts';
import type { FashionAnalysis } from './visual-tagger.ts';

export type CategoryType = 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes' | 'bag' | 'accessory' | 'set';

/**
 * Fashion Aesthetic types for category_folder
 * Represents the dominant style aesthetic of the product
 */
export type FashionAesthetic =
    | 'Boho Chic'
    | 'Vintage'
    | 'Sporty'
    | 'Preppy'
    | 'Minimalist'
    | 'Streetwear'
    | 'Chic'
    | 'Grunge'
    | 'Office'
    | 'Athleisure'
    | 'Cottagecore'
    | 'Y2K'
    | 'Classic'
    | 'Avant-Garde'
    | 'Casual'
    | string; // Allow other aesthetic strings

/**
 * Fashion Analysis result interface (re-exported from visual-tagger for convenience)
 */
export type { FashionAnalysis };

/**
 * Product color variation interface for lazy loading with visual analysis
 */
export interface ProductVariation {
    color_name: string;
    image_url: string | null; // Null if not yet crawled
    is_crawled: boolean;      // Flag to track status
    analysis?: FashionAnalysis; // Visual metadata from AI vision analysis
}

/**
 * Enriched product data interface - Visual-First schema
 * Styling attributes (color, fit, style_tags, occasion_tags) are now at variation level
 * Removed legacy text-first fields: productDetails, aboutThisItem, category_main, category_sub, category_occasion
 */
export interface EnrichedProduct {
    id: string; // generated slug
    title: string;
    brand: string;
    product_url: string; // Original Amazon URL
    image_url: string; // The high-res local path or URL (main product image)
    /**
     * Primary item type classification
     */
    category_type: CategoryType;
    /**
     * Fashion Aesthetic - dominant style aesthetic of the product
     * Examples: "Boho Chic", "Vintage", "Sporty", "Preppy", "Minimalist", "Streetwear", "Chic", "Grunge", "Office", "Athleisure", "Cottagecore", "Y2K", "Classic", "Avant-Garde", "Casual"
     */
    category_folder: FashionAesthetic;
    gender: 'womens';
    age_group: 'adult'; // Target 20-35
    description: string; // Basic context description (max 30-40 words)
    material: string[];
    pattern: string;
    silhouette: string; // e.g., "longline", "a-line"
    length: string;
    season: string[];
    sizes: string[]; // Normalized sizes
    price: number;
    currency: 'usd' | 'vnd';
    is_set: boolean; // true if it's a 2-piece set
    variations?: ProductVariation[]; // Color variations with lazy loading and visual analysis support
    // Note: color, fit, style_tags, occasion_tags are now in variations[].analysis
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
 * Infers category_type from title
 */
const inferCategoryType = (title: string): CategoryType => {
    const lowerTitle = title.toLowerCase();

    if (lowerTitle.includes('dress')) {
        return 'dress';
    }
    if (lowerTitle.includes('jacket') || lowerTitle.includes('blazer') || lowerTitle.includes('coat')) {
        return 'outerwear';
    }
    if (lowerTitle.includes('shirt') || lowerTitle.includes('blouse') || lowerTitle.includes('top') || lowerTitle.includes('tee')) {
        return 'top';
    }
    if (lowerTitle.includes('pants') || lowerTitle.includes('trousers') || lowerTitle.includes('skirt')) {
        return 'bottom';
    }
    if (lowerTitle.includes('shoes') || lowerTitle.includes('heels') || lowerTitle.includes('pumps') || lowerTitle.includes('sneakers')) {
        return 'shoes';
    }
    if (lowerTitle.includes('bag') || lowerTitle.includes('handbag') || lowerTitle.includes('purse') || lowerTitle.includes('clutch')) {
        return 'bag';
    }
    if (lowerTitle.includes('set') || lowerTitle.includes('2-piece') || lowerTitle.includes('outfit')) {
        return 'set';
    }
    if (lowerTitle.includes('jewelry') || lowerTitle.includes('scarf') || lowerTitle.includes('belt') || lowerTitle.includes('hat')) {
        return 'accessory';
    }

    return 'top'; // Default fallback
};

/**
 * Normalize size strings based on category_type.
 * - Clothes: map to XS / S / M / L / XL / XXL...
 * - Shoes: numeric strings only ("36", "37", "38", ...)
 * - Bags / Accessories: "One Size" (or existing strings cleaned)
 */
const normalizeSizes = (categoryType: CategoryType, rawSizes: unknown): string[] => {
    const toArray = (value: unknown): string[] => {
        if (!value) return [];
        if (Array.isArray(value)) return value.map((v) => String(v));
        if (typeof value === 'string') {
            return value
                .split(/[\/,]|or/gi)
                .map((v) => v.trim())
                .filter(Boolean);
        }
        return [];
    };

    const upper = toArray(rawSizes).map((s) => s.toUpperCase());

    if (categoryType === 'shoes') {
        const numeric = upper
            .map((s) => s.replace(/[^\d.]/g, ''))
            .filter((s) => s.length > 0);
        return Array.from(new Set(numeric));
    }

    if (categoryType === 'bag' || categoryType === 'accessory') {
        if (upper.length === 0) {
            return ['ONE SIZE'];
        }
        return Array.from(
            new Set(
                upper.map((s) => (s.includes('ONE') && s.includes('SIZE') ? 'ONE SIZE' : s.replace(/\s+/g, ' ').trim())),
            ),
        );
    }

    // Clothing sizes
    const sizeMap: Record<string, string> = {
        'X-SMALL': 'XS',
        XS: 'XS',
        'EXTRA SMALL': 'XS',
        SMALL: 'S',
        S: 'S',
        MEDIUM: 'M',
        M: 'M',
        LARGE: 'L',
        L: 'L',
        'X-LARGE': 'XL',
        XL: 'XL',
        'XX-LARGE': 'XXL',
        XXL: 'XXL',
        'XXX-LARGE': 'XXXL',
        XXXL: 'XXXL',
    };

    const normalized = upper.map((s) => sizeMap[s] || s);
    return Array.from(new Set(normalized));
};

/**
 * Calls Pinkyne/Gemini LLM to enrich a single product.
 * Uses axios to send the raw product JSON and returns a cleaned, enriched product.
 * Preserves any pre-scraped variations for hybrid/lazy-loading flows.
 */
export const enrichProduct = async (
    rawProduct: ProductDetails & { product_url?: string; variations?: ProductVariation[] }
): Promise<EnrichedProduct> => {
    const apiKey = process.env.PINKYNE_API_KEY;
    if (!apiKey) {
        throw new Error('PINKYNE_API_KEY environment variable is not set');
    }

    const baseUrl = 'https://api.pinkyne.com/v1';

    const schemaDescription = `
You must read the product data to fill the fields; return ONLY valid JSON matching this TypeScript schema:
{
  "id": "url-friendly-slug-from-title",
  "title": "exact product title",
  "brand": "brand name",
  "product_url": "original Amazon URL if available",
  "image_url": "first image URL from the list",
  "category_type": "one of: top, bottom, dress, outerwear, shoes, bag, accessory, set",
  "category_folder": "Fashion Aesthetic string (e.g., 'Boho Chic', 'Vintage', 'Sporty', 'Preppy', 'Minimalist', 'Streetwear', 'Chic', 'Grunge', 'Office', 'Athleisure', 'Cottagecore', 'Y2K', 'Classic', 'Avant-Garde', 'Casual')",
  "gender": "womens",
  "age_group": "adult",
  "description": "short but rich marketing description (max 30-40 words)",
  "material": ["array of materials in lowercase"],
  "pattern": "pattern type (e.g., solid, striped, floral, plaid) or 'none'",
  "silhouette": "silhouette description (e.g., longline, a-line, straight, fitted)",
  "length": "length description (e.g., short, midi, long, cropped)",
  "season": ["array of applicable seasons: spring, summer, fall, winter"],
  "sizes": ["array of available sizes after normalization"],
  "price": number,
  "currency": "usd",
  "is_set": boolean
}

IMPORTANT: Do NOT include these fields (they are now at variation level):
- "color" (colors are in variations[].color_name)
- "fit" (fit is in variations[].analysis)
- "style_tags" (style is in variations[].analysis.vibes)
- "occasion_tags" (occasions are in variations[].analysis.occasions)

Classification rules for category_type (PRIMARY CLASSIFICATION):
- top: shirts, blouses, blazers, t-shirts, sweaters.
- bottom: pants, skirts, shorts, jeans.
- dress: full body items, gowns, bodycon dress, maxi dress.
- outerwear: coats, jackets, cardigans, trench coats.
- shoes: heels, sneakers, boots, sandals, pumps, loafers.
- bag: handbags, clutches, totes, crossbody bags, backpacks.
- accessory: jewelry, scarves, belts, hats, hair accessories.
- set: two-piece or multi-piece coordinated outfits.

Fashion Aesthetic (category_folder) classification:
- Analyze the product title and description to determine the dominant Fashion Aesthetic.
- Choose from styles like: "Boho Chic", "Vintage", "Sporty", "Preppy", "Minimalist", "Streetwear", "Chic", "Grunge", "Office", "Athleisure", "Cottagecore", "Y2K", "Classic", "Avant-Garde", "Casual", or other appropriate aesthetic descriptors.
- Consider the overall design, materials, and style cues in the product description.
- Default to "Casual" if uncertain.

Size normalization:
- For clothing (top, bottom, dress, outerwear, set): normalize to size codes like ["XS","S","M","L","XL","XXL","XXXL"].
- For shoes: output only numeric strings like ["36","37","38","39","40"].
- For bags and accessories: use ["One Size"] when appropriate.

Rules:
- Fix typos and normalize material names.
- Generate a concise description from available product data (max 30-40 words, no fluff).
- Focus on identifying the correct category_type and Fashion Aesthetic.
- Return ONLY raw JSON, no markdown, no explanation.
- Do NOT include productDetails, aboutThisItem, color, fit, style_tags, or occasion_tags fields in the output.
`;

    const prompt = `
You are an AI Fashion Product Data Cleaner. I will give you a raw product JSON from Amazon.
Please correct typos, standardise fields (material), generate a short description,
and classify it by item type (category_type) and Fashion Aesthetic (category_folder) using the schema above.
Focus on identifying the correct category_type and dominant Fashion Aesthetic.

${schemaDescription}

Raw product JSON:
${JSON.stringify(rawProduct, null, 2)}
`;

    try {
        const response = await axios.post(
            `${baseUrl}/chat/completions`,
            {
                model: 'gpt-4o-mini', // or any suitable model on Pinkyne
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an AI Data Cleaner for fashion products. ' +
                            'Always return ONLY valid JSON, no extra explanation. ' +
                            'Keep the generated description concise (max 30-40 words). ' +
                            'Focus on identifying the correct category_type and Fashion Aesthetic (category_folder). ' +
                            'Do NOT include color, fit, style_tags, or occasion_tags in the output (these are handled at variation level). ' +
                            'Strictly follow the classification and size normalization rules in the schema.',
                    },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.2,
                max_tokens: 5000,
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

        const validTypes: CategoryType[] = ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'bag', 'accessory', 'set'];

        // Normalize category_type
        let typeFromModel: CategoryType | null =
            parsed.category_type && validTypes.includes(parsed.category_type) ? parsed.category_type : null;

        if (!typeFromModel) {
            // Infer from title
            typeFromModel = inferCategoryType(rawProduct.title);
        }

        parsed.category_type = typeFromModel;

        // Ensure category_folder (Fashion Aesthetic) is set, default to "Casual" if missing
        if (!parsed.category_folder || typeof parsed.category_folder !== 'string') {
            parsed.category_folder = 'Casual'; // Default fallback
        }

        // Ensure arrays
        parsed.material = Array.isArray(parsed.material) ? parsed.material : [];
        parsed.season = Array.isArray(parsed.season) ? parsed.season : [];

        // Normalize sizes using category_type (falling back to raw scraped sizes if needed)
        const rawSizesForNormalization = parsed.sizes && parsed.sizes.length > 0 ? parsed.sizes : rawProduct.sizes;
        parsed.sizes = normalizeSizes(parsed.category_type, rawSizesForNormalization);

        // Ensure numeric fields
        parsed.price = typeof parsed.price === 'number' ? parsed.price : rawProduct.price;
        parsed.currency = parsed.currency || 'usd';
        parsed.is_set = Boolean(parsed.is_set);

        // Explicitly remove legacy and moved fields if they exist
        delete parsed.productDetails;
        delete parsed.aboutThisItem;
        delete parsed.category_main;
        delete parsed.category_sub;
        delete parsed.category_occasion;
        // Remove fields that are now at variation level
        delete parsed.color;
        delete parsed.fit;
        delete parsed.style_tags;
        delete parsed.occasion_tags;

        // Preserve pre-scraped variations (hybrid crawler)
        if (rawProduct.variations) {
            parsed.variations = rawProduct.variations;
        }

        const enriched: EnrichedProduct = parsed as EnrichedProduct;

        log.info('Product data enriched (LLM)', {
            id: enriched.id,
            category_type: enriched.category_type,
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
