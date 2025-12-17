import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';
import type { EnrichedProduct } from './enricher.ts';

/**
 * User Profile interface
 */
export interface UserProfile {
    size?: string; // e.g., "M", "S", "L", "36", "37", etc.
    style?: string[]; // e.g., ["Korean", "Minimalist", "Chic"]
    body_shape?: string; // e.g., "pear", "hourglass", "apple", "rectangle"
    color_preferences?: string[]; // e.g., ["black", "white", "beige"]
    budget_range?: {
        min?: number;
        max?: number;
    };
    [key: string]: any; // Allow additional fields
}

/**
 * Simplified product candidate for LLM (to save tokens)
 * Sizes removed - already pre-filtered, LLM doesn't need this data
 */
interface SimplifiedProduct {
    id: string;
    title: string;
    color: string;
    category_type: string;
    price: number;
}

/**
 * LLM Outfit Response structure
 */
interface LLMOutfitResponse {
    outfits: Array<{
        name: string;
        reasoning: string;
        item_ids: string[];
    }>;
}

/**
 * Personalized Outfit Result
 */
export interface PersonalizedOutfitResult {
    outfits: Array<{
        name: string;
        reasoning: string;
        items: EnrichedProduct[];
    }>;
    category: 'casual' | 'hanging' | 'office' | 'party';
    message: string;
}

/**
 * Result interface for outfit suggestions
 */
export interface OutfitResult {
    items: EnrichedProduct[];
    category: 'casual' | 'hanging' | 'office' | 'party';
    message: string;
}

/**
 * Intelligent AI Stylist service for retrieving and suggesting personalized outfits
 */
export class SimpleStylist {
    // Parallel styling pipeline configuration
    private readonly PARALLEL_REQUESTS = 5; // Number of concurrent LLM calls
    private readonly OUTFITS_PER_REQUEST = 2; // Number of outfits per call (Total = 10)
    private readonly BATCH_SIZE = 35; // Number of items per batch

    private readonly productsBasePath = path.join('storage', 'products');
    private readonly userProfilePath = path.join('storage', 'user_profile.json');
    private apiKey: string | undefined;
    private baseUrl: string;

    constructor() {
        this.apiKey = process.env.PINKYNE_API_KEY || process.env.OPENAI_API_KEY;
        this.baseUrl = process.env.PINKYNE_API_BASE_URL || 'https://api.pinkyne.com/v1';
    }

    /**
     * Loads user profile from storage/user_profile.json
     * Returns a default profile if file doesn't exist
     */
    private loadUserProfile(): UserProfile {
        const filePath = this.userProfilePath;

        if (!fs.existsSync(filePath)) {
            console.warn(`User profile not found at ${filePath}. Using default profile.`);
            return {
                size: 'M',
                style: ['casual'],
                body_shape: 'rectangle',
                color_preferences: [],
            };
        }

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const profile = JSON.parse(raw) as UserProfile;
            console.log('user profile loaded');
            return profile;
        } catch (error) {
            console.error(`Error reading user profile from ${filePath}:`, error);
            return {
                size: 'M',
                style: ['casual'],
                body_shape: 'rectangle',
                color_preferences: [],
            };
        }
    }

    /**
     * Extracts JSON from LLM response (supports code blocks and plain JSON)
     */
    private extractJson(content: string): any {
        // Try to extract from markdown code block first
        const jsonMatch =
            content.match(/```json\s*([\s\S]*?)\s*```/i) ||
            content.match(/```\s*([\s\S]*?)\s*```/i);

        let jsonString = jsonMatch ? jsonMatch[1] : content;

        // Trim whitespace
        jsonString = jsonString.trim();

        // Try to isolate the JSON object between first '{' and last '}'
        const firstBrace = jsonString.indexOf('{');
        const lastBrace = jsonString.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            jsonString = jsonString.slice(firstBrace, lastBrace + 1);
        }

        // Parse JSON (will throw if invalid)
        return JSON.parse(jsonString);
    }

    /**
     * Size matcher: checks if a product size matches the user's size
     * Handles clothing sizes (XS, S, M, L, XL) and shoe sizes (numeric)
     */
    private doesSizeMatch(userSize: string | undefined, productSizes: string[]): boolean {
        if (!userSize || productSizes.length === 0) {
            return true; // If no user size specified, don't filter
        }

        const normalizedUserSize = userSize.toUpperCase().trim();
        const normalizedProductSizes = productSizes.map(s => s.toUpperCase().trim());

        // Check exact match
        if (normalizedProductSizes.includes(normalizedUserSize)) {
            return true;
        }

        // For clothing sizes, check if user size is within range
        // Size order: XS < S < M < L < XL < XXL < XXXL
        const sizeOrder = ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'];
        const userSizeIndex = sizeOrder.indexOf(normalizedUserSize);

        if (userSizeIndex !== -1) {
            // For clothing, allow adjacent sizes (e.g., M can wear S, M, or L)
            // But exclude sizes that are too far (e.g., M should not wear XS or XL)
            const allowedSizes = [
                sizeOrder[Math.max(0, userSizeIndex - 1)],
                sizeOrder[userSizeIndex],
                sizeOrder[Math.min(sizeOrder.length - 1, userSizeIndex + 1)],
            ];
            return normalizedProductSizes.some(ps => allowedSizes.includes(ps));
        }

        // For shoes, check numeric match (allow ±1 size)
        const userSizeNum = parseInt(normalizedUserSize.replace(/[^\d]/g, ''), 10);
        if (!isNaN(userSizeNum)) {
            return normalizedProductSizes.some(ps => {
                const productSizeNum = parseInt(ps.replace(/[^\d]/g, ''), 10);
                if (!isNaN(productSizeNum)) {
                    return Math.abs(productSizeNum - userSizeNum) <= 1;
                }
                return false;
            });
        }

        // If we can't determine, don't filter (be permissive)
        return true;
    }

    /**
     * Pre-filters products by size (hard rules)
     */
    private preFilterBySize(products: EnrichedProduct[], userSize: string | undefined): EnrichedProduct[] {
        if (!userSize) {
            return products; // No size filter if user size not specified
        }

        return products.filter(product => this.doesSizeMatch(userSize, product.sizes));
    }

    /**
     * Simplifies products for LLM (to save tokens)
     * Removes sizes (already pre-filtered), strips long text, keeps only essential styling data
     */
    private simplifyProducts(products: EnrichedProduct[]): SimplifiedProduct[] {
        return products.map(p => ({
            id: p.id,
            title: p.title.length > 80 ? p.title.substring(0, 80) + '...' : p.title, // Truncate long titles
            color: p.color || '',
            category_type: p.category_type,
            price: p.price,
            // Removed sizes - already pre-filtered by size logic, LLM doesn't need this
        }));
    }

    /**
     * Maps user message keywords to an array of category folders.
     * Allows cross-category styling by returning multiple categories.
     */
    private mapMessageToCategory(userMessage: string): string[] {
        const lowerMessage = userMessage.toLowerCase();

        // Work/Office keywords -> mix office and casual (modern workwear)
        const workKeywords = ['họp', 'công sở', 'đi làm', 'work', 'office', 'business', 'professional', 'corporate', 'formal', 'meeting', 'trousers', 'blazer'];
        if (workKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return ['office', 'casual'];
        }

        // Party/Wedding keywords -> mix party and hanging
        const partyKeywords = ['cưới', 'tiệc', 'party', 'prom', 'sang trọng', 'wedding', 'event', 'evening', 'cocktail', 'gala'];
        if (partyKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return ['party', 'hanging'];
        }

        // Date/Dinner keywords -> mix hanging, casual, and party
        const dateKeywords = ['date', 'dinner', 'dining', 'restaurant', 'brunch', 'eat', 'ăn tối', 'elegant'];
        if (dateKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return ['hanging', 'casual', 'party'];
        }

        // Hanging/Going out keywords
        const hangingKeywords = ['club', 'night', 'night out', 'hanging', 'going out', 'going', 'tops'];
        if (hangingKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return ['hanging', 'casual'];
        }

        // Casual/Street keywords -> mix casual and hanging
        const casualKeywords = ['cà phê', 'dạo phố', 'bạn bè', 'street', 'casual', 'everyday', 'daily', 'đi chơi', 'chơi', 'phố', 'streetwear', 'trip'];
        if (casualKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return ['casual', 'hanging'];
        }

        // Default: return all categories for generic queries
        return ['office', 'party', 'casual', 'hanging'];
    }

    /**
     * Loads all products from multiple category directories.
     * Reads all JSON files in storage/products/{category}/ for each category and merges them.
     */
    private loadInventory(categories: string[]): EnrichedProduct[] {
        const inventory: EnrichedProduct[] = [];

        for (const category of categories) {
            const categoryDir = path.join(this.productsBasePath, category);
            console.log(`📂 Loading category: ${category}`);

            // Check if directory exists
            if (!fs.existsSync(categoryDir) || !fs.statSync(categoryDir).isDirectory()) {
                console.warn(`Category directory ${categoryDir} does not exist.`);
                continue;
            }

            try {
                // Read all files in the directory
                const files = fs.readdirSync(categoryDir);

                // Filter for JSON files only
                const jsonFiles = files.filter(file => file.endsWith('.json'));

                // Read and merge all JSON files
                for (const jsonFile of jsonFiles) {
                    const filePath = path.join(categoryDir, jsonFile);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                            inventory.push(...(data as EnrichedProduct[]));
                            console.log(`  ✓ Loaded ${data.length} items from ${category}/${jsonFile}`);
                        } else {
                            console.warn(`  ⚠ File ${jsonFile} does not contain an array.`);
                        }
                    } catch (error) {
                        console.error(`  ✗ Error reading ${jsonFile}:`, error);
                    }
                }
        } catch (error) {
                console.error(`Error reading category directory ${categoryDir}:`, error);
        }
        }

        console.log(`📦 Found ${inventory.length} total items in inventory`);
        return inventory;
    }

    /**
     * Shuffles an array (Fisher-Yates shuffle)
     */
    private shuffle<T>(array: T[]): T[] {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    /**
     * Smart filtering: scores products based on user query keywords and balances by item type.
     * Returns balanced items up to maxItems (default ~35-40 for single request, ~300 for parallel).
     */
    private smartFilter(products: EnrichedProduct[], userQuery: string, maxItems: number = 40): EnrichedProduct[] {
        // Step A: Scoring
        const lowerQuery = userQuery.toLowerCase();
        const queryTokens = lowerQuery.split(/\s+/).filter(token => token.length > 2); // Filter out short words

        const scoredProducts = products.map(product => {
            let score = 0;
            const searchText = `${product.title} ${product.color} ${(product.style_tags || []).join(' ')}`.toLowerCase();

            // Check each query token against product fields
            for (const token of queryTokens) {
                if (product.title.toLowerCase().includes(token)) {
                    score += 10;
                }
                if (product.color && product.color.toLowerCase().includes(token)) {
                    score += 10;
                }
                if (product.style_tags && product.style_tags.some(tag => tag.toLowerCase().includes(token))) {
                    score += 10;
                }
            }

            return { product, score };
        });

        // Sort by score descending
        scoredProducts.sort((a, b) => b.score - a.score);

        // Step B: Quota Balancing (scales with maxItems for parallel processing)
        const scaleFactor = maxItems > 100 ? Math.floor(maxItems / 40) : 1;
        const quotas = {
            top: 10 * scaleFactor,
            bottom: 10 * scaleFactor,
            dress: 5 * scaleFactor,
            shoes: 6 * scaleFactor,
            bag: 2 * scaleFactor,
            accessory: 2 * scaleFactor,
            outerwear: 2 * scaleFactor,
            set: 2 * scaleFactor,
        };

        const selected: EnrichedProduct[] = [];
        const used = new Set<string>(); // Track used product IDs

        // Fill each quota bucket
        for (const [type, quota] of Object.entries(quotas)) {
            const matching = scoredProducts
                .filter(({ product }) => {
                    const productType = product.category_type || '';
                    return productType === type && !used.has(product.id);
                })
                .slice(0, quota);

            matching.forEach(({ product }) => {
                selected.push(product);
                used.add(product.id);
            });

            // If quota not filled, fill with random items of this type
            if (matching.length < quota) {
                const remaining = products.filter(
                    p => (p.category_type || '') === type && !used.has(p.id)
                );
                const shuffled = this.shuffle(remaining);
                const needed = quota - matching.length;
                shuffled.slice(0, needed).forEach(product => {
                    selected.push(product);
                    used.add(product.id);
                });
            }
        }

        console.log(`🎯 Smart filtered to ${selected.length} items (balanced by type)`);
        return selected;
    }

    /**
     * Creates balanced batches from filtered products for parallel LLM processing.
     * Each batch is a valid "mini-wardrobe" ensuring diversity across batches.
     */
    private createBalancedBatches(products: EnrichedProduct[]): EnrichedProduct[][] {
        // Step A: Separate products into type buckets
        const buckets: Record<string, EnrichedProduct[]> = {
            top: [],
            bottom: [],
            dress: [],
            shoes: [],
            bag: [],
            accessory: [],
            outerwear: [],
            set: [],
        };

        // Shuffle products first to ensure randomness
        const shuffled = this.shuffle([...products]);

        // Populate buckets
        for (const product of shuffled) {
            const type = product.category_type || 'top';
            if (buckets[type]) {
                buckets[type].push(product);
            } else {
                buckets.top.push(product); // Fallback to top
            }
        }

        // Step B: Create balanced batches
        const batches: EnrichedProduct[][] = [];
        const usedIds = new Set<string>();

        // Calculate items per type per batch (roughly balanced)
        const itemsPerType = Math.floor(this.BATCH_SIZE / Object.keys(buckets).length);

        for (let i = 0; i < this.PARALLEL_REQUESTS; i++) {
            const batch: EnrichedProduct[] = [];

            // For each type, randomly select items not yet used
            for (const [type, items] of Object.entries(buckets)) {
                const available = items.filter(p => !usedIds.has(p.id));
                const shuffled = this.shuffle([...available]);
                const needed = Math.min(itemsPerType, shuffled.length);
                const selected = shuffled.slice(0, needed);

                selected.forEach(product => {
                    batch.push(product);
                    usedIds.add(product.id);
                });
            }

            // If batch is still too small, fill with any remaining items
            if (batch.length < this.BATCH_SIZE) {
                const remaining = shuffled.filter(p => !usedIds.has(p.id));
                const needed = Math.min(this.BATCH_SIZE - batch.length, remaining.length);
                const additional = this.shuffle([...remaining]).slice(0, needed);
                additional.forEach(product => {
                    batch.push(product);
                    usedIds.add(product.id);
                });
            }

            if (batch.length > 0) {
                batches.push(batch);
                console.log(`📦 Batch ${i + 1}: ${batch.length} items (unique, balanced)`);
            }
        }

        return batches;
    }

    /**
     * Suggests personalized outfits using AI/LLM based on user query and profile
     */
    async suggestPersonalizedOutfits(userQuery: string): Promise<PersonalizedOutfitResult> {
        // Step 1: Load user profile
        const userProfile = this.loadUserProfile();

        // Step 2: Identify categories from userQuery (now returns array)
        const categories = this.mapMessageToCategory(userQuery);
        console.log(`📋 Selected categories: ${categories.join(', ')}`);

        // Step 3: Load ALL products from all selected category directories
        const rawInventory = this.loadInventory(categories);

        if (rawInventory.length === 0) {
            return {
                outfits: [],
                category: categories[0] as 'casual' | 'hanging' | 'office' | 'party',
                message: `No products found in categories: ${categories.join(', ')}`,
            };
        }

        // Step 4: Pre-filter by size (hard rules)
        const filteredProducts = this.preFilterBySize(rawInventory, userProfile.size);

        if (filteredProducts.length === 0) {
            return {
                outfits: [],
                category: categories[0] as 'casual' | 'hanging' | 'office' | 'party',
                message: `No products found that match your size (${userProfile.size || 'any'})`,
            };
        }

        // Step 5: Smart filtering - load larger pool for parallel processing (up to 300 items)
        const productsForLLM = this.smartFilter(filteredProducts, userQuery, 300);

        if (productsForLLM.length === 0) {
            return {
                outfits: [],
                category: categories[0] as 'casual' | 'hanging' | 'office' | 'party',
                message: `No products found after smart filtering`,
            };
        }

        // Step 6: Create balanced batches for parallel processing
        const batches = this.createBalancedBatches(productsForLLM);

        if (batches.length === 0) {
            return {
                outfits: [],
                category: categories[0] as 'casual' | 'hanging' | 'office' | 'party',
                message: `Failed to create batches for parallel processing`,
            };
        }

        // Step 7: Parallel LLM execution
        if (!this.apiKey) {
            console.warn('PINKYNE_API_KEY not set. Falling back to random selection.');
            return this.fallbackToRandomSelection(filteredProducts, categories[0] as 'casual' | 'hanging' | 'office' | 'party');
        }

        console.log(`🚀 Starting parallel LLM requests (${batches.length} batches, ${this.OUTFITS_PER_REQUEST} outfits each)...`);
        const llmTimeoutMs = 120000; // 2 minutes timeout per request

        // Execute all batches in parallel using Promise.allSettled
        const batchPromises = batches.map((batch, index) => {
            const simplifiedBatch = this.simplifyProducts(batch);
            const llmCall = this.callLLMForOutfitSelection(
                userProfile,
                userQuery,
                simplifiedBatch,
            );

            const timeoutPromise = new Promise<LLMOutfitResponse>((_, reject) =>
                setTimeout(() => reject(new Error(`Batch ${index + 1} timed out`)), llmTimeoutMs),
            );

            return Promise.race([llmCall, timeoutPromise])
                .then(response => ({ success: true, batchIndex: index, response }))
                .catch(error => ({ success: false, batchIndex: index, error }));
        });

        const results = await Promise.allSettled(batchPromises);

        // Step 8: Aggregate successful results
        const successfulResponses: LLMOutfitResponse[] = [];
        let successCount = 0;
        let failureCount = 0;

        for (const result of results) {
            if (result.status === 'fulfilled') {
                const value = result.value;
                if (value.success && 'response' in value) {
                    successfulResponses.push(value.response);
                    successCount++;
                } else {
                    failureCount++;
                    const error = 'error' in value ? value.error : 'Unknown error';
                    const batchIndex = 'batchIndex' in value ? value.batchIndex : -1;
                    console.warn(`Batch ${batchIndex + 1} failed:`, error);
                }
            } else {
                failureCount++;
                console.warn('Batch failed (rejected):', result.reason);
            }
        }

        console.log(`✅ Parallel processing complete: ${successCount} succeeded, ${failureCount} failed`);

        // Merge all outfits from successful responses
        const allOutfits: LLMOutfitResponse['outfits'] = [];
        for (const response of successfulResponses) {
            if (response.outfits && Array.isArray(response.outfits)) {
                allOutfits.push(...response.outfits);
            }
        }

        if (allOutfits.length === 0) {
            console.error('No outfits generated from parallel requests, falling back to random selection');
            return this.fallbackToRandomSelection(filteredProducts, categories[0] as 'casual' | 'hanging' | 'office' | 'party');
        }

        // Step 9: Final assembly - retrieve full product details
        const mergedResponse: LLMOutfitResponse = { outfits: allOutfits };
        const outfits = await this.assembleOutfits(mergedResponse, filteredProducts);

        // Shuffle and limit to 10 outfits for diversity
        const shuffledOutfits = this.shuffle(outfits).slice(0, 10);

        return {
            outfits: shuffledOutfits,
            category: categories[0] as 'casual' | 'hanging' | 'office' | 'party',
            message: `Generated ${shuffledOutfits.length} personalized outfit(s) from ${successCount} parallel requests`,
        };
    }

    /**
     * Calls LLM (Pinkyne/Gemini) to select the best outfit combinations
     */
    private async callLLMForOutfitSelection(
        userProfile: UserProfile,
        userQuery: string,
        candidates: SimplifiedProduct[],
    ): Promise<LLMOutfitResponse> {
        const prompt = `ROLE: You are an Elite High-Fashion Stylist and Image Consultant with decades of experience in luxury fashion styling, color analysis, and body architecture. Your taste is impeccable, sophisticated, and deeply personalized.
CONTEXT:
- **User Profile:** ${JSON.stringify(userProfile, null, 2)}
- **User Request:** "${userQuery}"
- **Wardrobe Inventory:** ${JSON.stringify(candidates, null, 2)}
YOUR MISSION:
Curate exactly ${this.OUTFITS_PER_REQUEST} distinct, high-end outfits that not only meet the user's request but elevate their personal style. Do not just pick items; *style* them. Each outfit must be unique and different from the others.
STYLING GUIDELINES (Strictly Adhere):
1.  **Body Architecture & Proportion:**
    -   Analyze the user's 'body_shape' (e.g., Pear, Hourglass, Rectangle) and 'height_cm'.
    -   Select silhouettes that balance their specific proportions (e.g., emphasize waist for Hourglass, draw attention upward for Pear, create curves for Rectangle).
    -   Use vertical lines or monochrome looks to elongate if height < 160cm.
2.  **Color Theory & Skin Tone:**
    -   Consider the user's 'skin_tone' and 'color_preferences'.
    -   Apply advanced color harmonies (Monochromatic, Analogous, Complementary, or Triadic).
    -   Avoid colors that might wash out the specific skin tone described.
3.  **The "Third Piece" Rule:**
    -   Elevate simple looks by adding a layer (Outerwear/Blazer) or a statement Accessory (Scarf/Jewelry/Bag) to add depth and visual interest.
4.  **Occasion Appropriateness:**
    -   Ensure the formality level perfectly matches the specific context of the User Request (e.g., "Board Meeting" vs "Casual Coffee").
5.  **Outfit Structure:**
    -   Valid Set 1: Top + Bottom + (Optional: Outerwear) + Shoes + Bag.
    -   Valid Set 2: Dress + (Optional: Outerwear) + Shoes + Bag.
    -   *Crucial:* Accessories are highly encouraged to complete the look.
6.  **STRICT RULE - No Duplicates:**
    -   Select EXACTLY ONE item per category (1 Top, 1 Bottom, 1 Shoes, 1 Bag, max 2 Accessories).
    -   Do NOT include 2 pairs of pants, 2 shirts, or multiple items of the same type.
    -   If selecting a Dress, do NOT include Top or Bottom (dress replaces both).
OUTPUT FORMAT (JSON ONLY):
Return valid JSON with this exact structure. You MUST return exactly ${this.OUTFITS_PER_REQUEST} outfits:
{
    "outfits": [
        {
            "name": "Creative & Sophisticated Title (e.g., 'Parisian Chic Power Suit', 'Effortless Weekend Luxe')",
            "reasoning": "A professional, persuasive explanation (max 50 words). Specifically mention WHY these items work for the user's BODY SHAPE, SKIN TONE, and STYLE. Use fashion terminology (e.g., 'cinched waist', 'elongating silhouette', 'tonal palette').",
            "item_ids": ["id_1", "id_2", "id_3", "id_4"]
        },
        {
            "name": "...",
            "reasoning": "...",
            "item_ids": [...]
        }
    ]
}`;

        console.log('📝 Prompt size:', prompt.length, 'characters');
        console.log('📦 Inventory size:', candidates.length, 'items');

        const response = await axios.post(
            `${this.baseUrl}/chat/completions`,
            {
                model: 'gpt-4o-mini', // or 'gemini-2.5-flash' if available
                messages: [
                    {
                        role: 'system',
                        content:
                            'You are an AI Fashion Stylist. ' +
                            'Create personalized, complete outfits that match the user\'s style, body shape, and occasion. ' +
                            'Always return valid JSON matching the specified format. ' +
                            'Ensure outfits are complete (all required pieces) and color-coordinated. ' +
                            '**STRICT RULE:** Select EXACTLY ONE item per category (e.g., 1 Top + 1 Bottom OR 1 Dress, not both). Do NOT include 2 pairs of pants, 2 shirts, or a dress with a top/bottom. Maximum 2 accessories allowed.',
                    },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.7,
                max_tokens: 15000,
                stream: false,
            },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 120000, // 2 minutes
            }
        );

        const content: string | undefined =
            response.data?.choices?.[0]?.message?.content ?? response.data?.choices?.[0]?.message;

        if (!content) {
            throw new Error('Empty response from LLM API');
        }
        console.log('📝 LLM Response:', content);

        try {
            const parsed = this.extractJson(content);
            return parsed as LLMOutfitResponse;
        } catch (err) {
            throw new Error(
                `Failed to parse LLM response: ${(err as Error).message}\nRaw content: ${content.slice(0, 800)}`
            );
        }
    }

    /**
     * Assembles full outfit details from LLM response item IDs
     * Enforces logical wardrobe constraints to prevent duplicate item types
     */
    private async assembleOutfits(
        llmResponse: LLMOutfitResponse,
        allProducts: EnrichedProduct[],
    ): Promise<Array<{ name: string; reasoning: string; items: EnrichedProduct[] }>> {
        const productMap = new Map<string, EnrichedProduct>();
        allProducts.forEach(p => productMap.set(p.id, p));

        // Define type limits (max items per type per outfit)
        const typeLimits: Record<string, number> = {
            top: 1,
            bottom: 1,
            dress: 1,
            shoes: 1,
            bag: 1,
            outerwear: 1,
            accessory: 2,
            set: 1,
        };

        return llmResponse.outfits
            .map(outfit => {
                // Step 1: Map item IDs to products
                const rawItems = outfit.item_ids
                    .map(id => productMap.get(id))
                    .filter((item): item is EnrichedProduct => item !== undefined);

                if (rawItems.length < 2) {
                    console.warn(`Discarding outfit "${outfit.name}" because only ${rawItems.length} valid item(s) found`);
                    return null;
                }

                // Step 2: Enforce logical wardrobe constraints
                const filteredItems: EnrichedProduct[] = [];
                const usedTypes = new Map<string, number>(); // Track count per type
                let hasDress = false;

                // First pass: identify if dress exists
                for (const item of rawItems) {
                    if (item.category_type === 'dress') {
                        hasDress = true;
                        break;
                    }
                }

                // Second pass: filter items with conflict resolution
                for (const item of rawItems) {
                    const itemType = item.category_type || 'top';
                    const currentCount = usedTypes.get(itemType) || 0;
                    const limit = typeLimits[itemType] || 1;

                    // Conflict: Dress vs Top/Bottom
                    if (hasDress && (itemType === 'top' || itemType === 'bottom')) {
                        console.warn(`Discarding ${itemType} from outfit "${outfit.name}" because dress is present`);
                        continue;
                    }

                    // Conflict: Duplicate type (Highlander rule - keep first, discard rest)
                    if (currentCount >= limit) {
                        console.warn(`Discarding duplicate ${itemType} from outfit "${outfit.name}" (limit: ${limit})`);
                        continue;
                    }

                    // Item is valid - add it
                    filteredItems.push(item);
                    usedTypes.set(itemType, currentCount + 1);
                }

                if (filteredItems.length < 2) {
                    console.warn(`Discarding outfit "${outfit.name}" because only ${filteredItems.length} valid item(s) after constraint filtering`);
                    return null;
                }

                return {
                    name: outfit.name,
                    reasoning: outfit.reasoning,
                    items: filteredItems,
                };
            })
            .filter((outfit): outfit is { name: string; reasoning: string; items: EnrichedProduct[] } => outfit !== null);
    }

    /**
     * Fallback to random selection if LLM fails
     */
    private fallbackToRandomSelection(
        products: EnrichedProduct[],
        category: 'casual' | 'hanging' | 'office' | 'party',
    ): PersonalizedOutfitResult {
        const shuffled = this.shuffle(products);
        // Create a simple outfit from first few items
        const items = shuffled.slice(0, Math.min(4, shuffled.length));

        return {
            outfits: [
                {
                    name: `Random ${category} Outfit`,
                    reasoning: 'Selected randomly (LLM unavailable)',
                    items,
                },
            ],
            category,
            message: `Generated 1 random outfit for ${category} (LLM unavailable)`,
        };
    }

    /**
     * Suggests an outfit based on user message (legacy method, kept for backward compatibility)
     */
    async suggestOutfit(userMessage: string): Promise<OutfitResult> {
        // Step 1: Map message to categories (now returns array)
        const categories = this.mapMessageToCategory(userMessage);
        const category = categories[0] as 'casual' | 'hanging' | 'office' | 'party';

        // Step 2: Load products from all categories
        const products = this.loadInventory(categories);

        if (products.length === 0) {
            return {
                items: [],
                category,
                message: `No products found in categories: ${categories.join(', ')}`,
            };
        }

        const shuffled = this.shuffle(products);

        return {
            items: shuffled,
            category,
            message: `Found ${products.length} item(s) from categories: ${categories.join(', ')}`,
        };
    }

    /**
     * Gets all available products in a category (for debugging/testing)
     */
    getAllProductsInCategory(category: 'casual' | 'hanging' | 'office' | 'party'): EnrichedProduct[] {
        return this.loadInventory([category]);
    }

    /**
     * Deletes a product by id from a specific category directory.
     * Searches through all JSON files in the category folder.
     */
    deleteProduct(category: 'casual' | 'hanging' | 'office' | 'party', productId: string): boolean {
        const categoryDir = path.join(this.productsBasePath, category);

        if (!fs.existsSync(categoryDir) || !fs.statSync(categoryDir).isDirectory()) {
            return false;
        }

        try {
            const files = fs.readdirSync(categoryDir);
            const jsonFiles = files.filter(file => file.endsWith('.json'));

            // Search through all JSON files to find and remove the product
            for (const jsonFile of jsonFiles) {
                const filePath = path.join(categoryDir, jsonFile);
        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw) as EnrichedProduct[];
            const filtered = data.filter((item) => item.id !== productId);

                    // If product was found and removed, write back the filtered array
                    if (filtered.length < data.length) {
                        fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
                        console.log(`✓ Deleted product ${productId} from ${category}/${jsonFile}`);
                        return true;
                    }
                } catch (error) {
                    console.error(`Error processing ${jsonFile} for deletion:`, error);
                }
            }

            return false; // product not found in any file
        } catch (error) {
            console.error(`Failed to delete product ${productId} from ${category}:`, error);
            return false;
        }
    }
}


