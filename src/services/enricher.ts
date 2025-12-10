import { log } from 'crawlee';
import axios from 'axios';
import type { ProductDetails } from '../scraper.ts';

export type CategoryOccasion = 'casual' | 'hanging' | 'office' | 'party';
export type CategoryType = 'top' | 'bottom' | 'dress' | 'outerwear' | 'shoes' | 'bag' | 'accessory' | 'set';

/**
 * Enriched product data interface matching the strict schema
 */
export interface EnrichedProduct {
    id: string; // generated slug
    title: string;
    brand: string;
    product_url: string;
    image_url: string; // The high-res local path or URL
    /**
     * High-level garment type (kept for backward compatibility)
     */
    category_main: Exclude<CategoryType, 'bag'> | 'accessory';
    category_sub: string; // e.g., "long_hooded_jacket", "pencil_skirt"
    /**
     * Occasion (primary dimension)
     */
    category_occasion: CategoryOccasion;
    /**
     * Item type (secondary dimension, used for hierarchical storage)
     */
    category_type: CategoryType;
    /**
     * Legacy occasion field (kept for compatibility, mirrors category_occasion)
     */
    category_folder: CategoryOccasion;
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
    sizes: string[]; // Normalized sizes
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
  "category_occasion": "one of: casual, hanging, office, party",
  "category_type": "one of: top, bottom, dress, outerwear, shoes, bag, accessory, set",
  "category_folder": "same as category_occasion (legacy field)",
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
  "sizes": ["array of available sizes after normalization"],
  "price": number,
  "currency": "usd",
  "is_set": boolean,
  "productDetails": { "key": "value", "...": "..." },
  "aboutThisItem": ["bullet1", "bullet2", "..."]
}

Classification rules for category_type:
- top: shirts, blouses, blazers, t-shirts, sweaters.
- bottom: pants, skirts, shorts, jeans.
- dress: full body items, gowns, bodycon dress, maxi dress.
- outerwear: coats, jackets, cardigans, trench coats.
- shoes: heels, sneakers, boots, sandals, pumps, loafers.
- bag: handbags, clutches, totes, crossbody bags, backpacks.
- accessory: jewelry, scarves, belts, hats, hair accessories.
- set: two-piece or multi-piece coordinated outfits.

Size normalization:
- For clothing (top, bottom, dress, outerwear, set): normalize to size codes like ["XS","S","M","L","XL","XXL","XXXL"].
- For shoes: output only numeric strings like ["36","37","38","39","40"].
- For bags and accessories: use ["One Size"] when appropriate.

Rules:
- Fix typos and normalize material/color names.
- Use aboutThisItem bullets to build a concise description (max 30-40 words, no fluff).
- Choose EXACTLY ONE of [office, party, casual, hanging] for category_occasion (and mirror it to category_folder).
- Return ONLY raw JSON, no markdown, no explanation.
`;

    const prompt = `
You are an AI Fashion Product Data Cleaner. I will give you a raw product JSON from Amazon.
Please correct typos, standardise fields (material, color), generate a short description based on "aboutThisItem",
and classify it by occasion AND item type using the schema above.

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
        if (!parsed.category_main || !parsed.category_sub) {
            const inferred = inferCategory(rawProduct.title);
            parsed.category_main = parsed.category_main || inferred.category_main;
            parsed.category_sub = parsed.category_sub || inferred.category_sub;
        }

        const validOccasions: CategoryOccasion[] = ['casual', 'office', 'party', 'hanging'];
        const validTypes: CategoryType[] = ['top', 'bottom', 'dress', 'outerwear', 'shoes', 'bag', 'accessory', 'set'];

        // Normalize occasion fields
        let occasion: CategoryOccasion =
            parsed.category_occasion && validOccasions.includes(parsed.category_occasion)
                ? parsed.category_occasion
                : parsed.category_folder && validOccasions.includes(parsed.category_folder)
                  ? parsed.category_folder
                  : 'casual';

        parsed.category_occasion = occasion;
        parsed.category_folder = occasion; // keep legacy in sync

        // Normalize type field
        let typeFromModel: CategoryType | null =
            parsed.category_type && validTypes.includes(parsed.category_type) ? parsed.category_type : null;

        if (!typeFromModel) {
            // Derive from category_main or inferred category
            const inferred = inferCategory(rawProduct.title);
            const mapping: Record<string, CategoryType> = {
                outerwear: 'outerwear',
                top: 'top',
                bottom: 'bottom',
                dress: 'dress',
                shoes: 'shoes',
                accessory: 'accessory',
                set: 'set',
            };
            const fromMain =
                parsed.category_main && mapping[parsed.category_main]
                    ? mapping[parsed.category_main]
                    : mapping[inferred.category_main];
            typeFromModel = fromMain || 'top';
        }

        parsed.category_type = typeFromModel;

        // Ensure arrays
        parsed.material = Array.isArray(parsed.material) ? parsed.material : [];
        parsed.season = Array.isArray(parsed.season) ? parsed.season : [];
        parsed.style_tags = Array.isArray(parsed.style_tags) ? parsed.style_tags : [];
        parsed.occasion_tags = Array.isArray(parsed.occasion_tags) ? parsed.occasion_tags : [];

        // Normalize sizes using category_type (falling back to raw scraped sizes if needed)
        const rawSizesForNormalization = parsed.sizes && parsed.sizes.length > 0 ? parsed.sizes : rawProduct.sizes;
        parsed.sizes = normalizeSizes(parsed.category_type, rawSizesForNormalization);

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
            category_occasion: enriched.category_occasion,
            category_type: enriched.category_type,
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
