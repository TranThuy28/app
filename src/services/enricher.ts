import { log } from 'crawlee';
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
    category_folder: 'di_lam' | 'di_choi' | 'di_an' | 'di_tiec'; // Occasion-based classification
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
 * Rule-based classification by keywords
 * Priority: di_tiec -> di_lam -> di_an -> di_choi (default)
 */
const classifyProductByKeywords = (title: string, bullets: string[]): string => {
    const text = `${title} ${bullets.join(' ')}`.toLowerCase();

    // di_tiec keywords (highest priority)
    const diTiecKeywords = ['gown', 'evening', 'party', 'wedding', 'cocktail', 'sequin', 'prom', 'event', 'celebration', 'luxury', 'glamorous', 'velvet'];
    if (diTiecKeywords.some(keyword => text.includes(keyword))) {
        return 'di_tiec';
    }

    // di_lam keywords
    const diLamKeywords = ['blazer', 'suit', 'office', 'work', 'professional', 'trousers', 'button down', 'formal', 'business', 'corporate', 'career', 'pencil skirt', 'pumps', 'loafers', 'flats'];
    if (diLamKeywords.some(keyword => text.includes(keyword))) {
        return 'di_lam';
    }

    // di_an keywords
    const diAnKeywords = ['date', 'romantic', 'midi', 'dressy', 'blouse', 'dining', 'restaurant', 'brunch', 'smart casual', 'refined', 'sophisticated'];
    if (diAnKeywords.some(keyword => text.includes(keyword))) {
        return 'di_an';
    }

    // Default to di_choi
    return 'di_choi';
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
 * Extracts material from productDetails or aboutThisItem
 */
const extractMaterial = (productDetails: Record<string, string>, bullets: string[]): string[] => {
    const materials: string[] = [];
    const materialKeywords = ['cotton', 'polyester', 'silk', 'wool', 'linen', 'rayon', 'spandex', 'elastane', 'nylon', 'viscose', 'modal', 'cashmere', 'denim', 'leather', 'suede', 'velvet', 'satin'];

    // Check productDetails
    for (const [key, value] of Object.entries(productDetails)) {
        const lowerKey = key.toLowerCase();
        const lowerValue = value.toLowerCase();
        if (lowerKey.includes('material') || lowerKey.includes('fabric') || lowerKey.includes('composition')) {
            for (const keyword of materialKeywords) {
                if (lowerValue.includes(keyword) && !materials.includes(keyword)) {
                    materials.push(keyword);
                }
            }
        }
    }

    // Check bullets
    const allText = bullets.join(' ').toLowerCase();
    for (const keyword of materialKeywords) {
        if (allText.includes(keyword) && !materials.includes(keyword)) {
            materials.push(keyword);
        }
    }

    return materials.length > 0 ? materials : ['fabric'];
};

/**
 * Extracts color from title or productDetails
 */
const extractColor = (title: string, productDetails: Record<string, string>): string => {
    const colors = ['black', 'white', 'red', 'blue', 'green', 'yellow', 'pink', 'purple', 'orange', 'brown', 'gray', 'grey', 'navy', 'beige', 'khaki', 'burgundy', 'maroon', 'teal', 'coral', 'ivory', 'cream'];
    const lowerTitle = title.toLowerCase();

    for (const color of colors) {
        if (lowerTitle.includes(color)) {
            return color;
        }
    }

    // Check productDetails
    for (const [key, value] of Object.entries(productDetails)) {
        if (key.toLowerCase().includes('color')) {
            return value.toLowerCase();
        }
    }

    return 'unknown';
};

/**
 * Generates description from first 2-3 bullet points
 */
const generateDescription = (bullets: string[]): string => {
    if (bullets.length === 0) {
        return 'Fashionable outfit designed for modern women.';
    }

    const selectedBullets = bullets.slice(0, 3);
    return selectedBullets.join(' ').substring(0, 300); // Limit to 300 chars
};

/**
 * Enriches raw Amazon product data using rule-based classification (synchronous, no LLM)
 * @param rawProduct - The raw scraped product data
 * @param productUrl - The original Amazon product URL (optional)
 * @returns Enriched product data matching the strict schema
 */
export const enrichProductData = (
    rawProduct: ProductDetails,
    productUrl?: string
): EnrichedProduct => {
    // Generate ID from title
    const id = generateSlug(rawProduct.title);

    // Extract brand
    const brand = extractBrand(rawProduct.title);

    // Infer category
    const { category_main, category_sub } = inferCategory(rawProduct.title);

    // Classify by keywords (synchronous)
    const category_folder = classifyProductByKeywords(rawProduct.title, rawProduct.aboutThisItem) as EnrichedProduct['category_folder'];

    // Extract material
    const material = extractMaterial(rawProduct.productDetails, rawProduct.aboutThisItem);

    // Extract color
    const color = extractColor(rawProduct.title, rawProduct.productDetails);

    // Generate description from bullets
    const description = generateDescription(rawProduct.aboutThisItem);

    // Extract sizes
    const sizes: string[] = [];
    if (rawProduct.size) {
        sizes.push(rawProduct.size);
    }
    // Try to extract sizes from productDetails
    if (rawProduct.productDetails) {
        const sizeKeys = Object.keys(rawProduct.productDetails).filter(key =>
            key.toLowerCase().includes('size')
        );
        if (sizeKeys.length > 0) {
            const sizeValue = rawProduct.productDetails[sizeKeys[0]];
            const parsedSizes = sizeValue.split(',').map(s => s.trim());
            sizes.push(...parsedSizes);
        }
    }
    const finalSizes = sizes.length > 0 ? sizes : ['S', 'M', 'L', 'XL'];

    // Check if it's a set
    const is_set = rawProduct.title.toLowerCase().includes('set') ||
                   rawProduct.title.toLowerCase().includes('2-piece') ||
                   rawProduct.title.toLowerCase().includes('outfit') ||
                   rawProduct.aboutThisItem.some(bullet => bullet.toLowerCase().includes('set'));

    // Infer style and occasion tags from category_folder
    const style_tags: string[] = [];
    const occasion_tags: string[] = [];
    
    if (category_folder === 'di_lam') {
        style_tags.push('office', 'professional', 'corporate');
        occasion_tags.push('work', 'business');
    } else if (category_folder === 'di_tiec') {
        style_tags.push('elegant', 'glamorous', 'formal');
        occasion_tags.push('party', 'wedding', 'event', 'formal');
    } else if (category_folder === 'di_an') {
        style_tags.push('smart casual', 'refined', 'sophisticated');
        occasion_tags.push('date', 'dining', 'restaurant');
    } else {
        style_tags.push('casual', 'streetwear', 'everyday');
        occasion_tags.push('daily', 'casual');
    }

    // Build enriched product
    const enriched: EnrichedProduct = {
        id,
        title: rawProduct.title,
        brand,
        product_url: productUrl || '',
        image_url: rawProduct.imageUrls[0] || '',
        category_main,
        category_sub,
        category_folder,
        gender: 'womens',
        age_group: 'adult',
        description,
        material,
        color,
        pattern: 'none', // Default, can be enhanced later
        fit: 'regular', // Default
        silhouette: 'regular', // Default
        length: 'regular', // Default
        season: ['all'], // Default to all seasons
        style_tags,
        occasion_tags,
        sizes: finalSizes,
        price: rawProduct.price,
        currency: 'usd',
        is_set,
        productDetails: rawProduct.productDetails || {},
        aboutThisItem: rawProduct.aboutThisItem || [],
    };

    log.info('Product data enriched (rule-based)', {
        id: enriched.id,
        category: enriched.category_main,
        category_folder: enriched.category_folder,
        brand: enriched.brand,
    });

    return enriched;
};
