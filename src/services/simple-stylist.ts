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
 */
interface SimplifiedProduct {
    id: string;
    title: string;
    color: string;
    category_type: string;
    category_sub: string;
    sizes: string[];
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
     */
    private simplifyProducts(products: EnrichedProduct[]): SimplifiedProduct[] {
        return products.map(p => ({
            id: p.id,
            title: p.title,
            color: p.color,
            category_type: p.category_type,
            category_sub: p.category_sub,
            sizes: p.sizes,
            price: p.price,
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
     * Returns ~60 items with balanced quotas for tops, bottoms, shoes, etc.
     */
    private smartFilter(products: EnrichedProduct[], userQuery: string): EnrichedProduct[] {
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

        // Step B: Quota Balancing
        const quotas = {
            top: 15,
            bottom: 15,
            dress: 10,
            shoes: 10,
            bag: 5,
            accessory: 5,
            outerwear: 5,
            set: 5,
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

        // Step 5: Smart filtering - score by keywords and balance by item type
        const productsForLLM = this.smartFilter(filteredProducts, userQuery);

        if (productsForLLM.length === 0) {
            return {
                outfits: [],
                category: categories[0] as 'casual' | 'hanging' | 'office' | 'party',
                message: `No products found after smart filtering`,
            };
        }

        // Step 6: Prepare simplified candidates for LLM
        const simplifiedCandidates = this.simplifyProducts(productsForLLM);

        // Step 7: Call LLM for intelligent selection
        if (!this.apiKey) {
            console.warn('PINKYNE_API_KEY not set. Falling back to random selection.');
            return this.fallbackToRandomSelection(filteredProducts, categories[0] as 'casual' | 'hanging' | 'office' | 'party');
        }

        console.log('🤖 Sending request to LLM...');
        try {
            const llmResponse = await this.callLLMForOutfitSelection(
                userProfile,
                userQuery,
                simplifiedCandidates,
            );

            // Step 8: Final assembly - retrieve full product details from the full filtered list
            // (not just the smart filtered list, so we can find all products)
            const outfits = await this.assembleOutfits(llmResponse, filteredProducts);

            return {
                outfits,
                category: categories[0] as 'casual' | 'hanging' | 'office' | 'party',
                message: `Generated ${outfits.length} personalized outfit(s) from categories: ${categories.join(', ')}`,
            };
        } catch (error) {
            console.error('LLM outfit selection failed:', error);
            return this.fallbackToRandomSelection(filteredProducts, categories[0] as 'casual' | 'hanging' | 'office' | 'party');
        }
    }

    /**
     * Calls LLM (Pinkyne/Gemini) to select the best outfit combinations
     */
    private async callLLMForOutfitSelection(
        userProfile: UserProfile,
        userQuery: string,
        candidates: SimplifiedProduct[],
    ): Promise<LLMOutfitResponse> {
        const prompt = `User Profile: ${JSON.stringify(userProfile, null, 2)}

User Request: ${userQuery}

Inventory: ${JSON.stringify(candidates, null, 2)}

Task: Create 2 distinct, complete outfits.

Rules:
1. Outfit Structure: (Top + Bottom + Shoes + Bag) OR (Dress + Shoes + Bag). Accessories are optional.
2. Style Matching: Match the user's style (e.g., Korean, Minimalist) and body shape.
3. Color Coordination: Ensure items match color-wise.

Return JSON format:
{
    "outfits": [
        {
            "name": "Outfit Name (e.g., Chic Office Lady)",
            "reasoning": "Why this fits the user...",
            "item_ids": ["id_of_top", "id_of_bottom", "id_of_shoes", ...]
        },
        ...
    ]
}`;

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
                            'Ensure outfits are complete (all required pieces) and color-coordinated.',
                    },
                    { role: 'user', content: prompt },
                ],
                temperature: 0.7,
                max_tokens: 5000,
                stream: false,
            },
            {
                headers: {
                    Authorization: `Bearer ${this.apiKey}`,
                    'Content-Type': 'application/json',
                },
                timeout: 60000,
            }
        );

        const content: string | undefined =
            response.data?.choices?.[0]?.message?.content ?? response.data?.choices?.[0]?.message;

        if (!content) {
            throw new Error('Empty response from LLM API');
        }

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
     */
    private async assembleOutfits(
        llmResponse: LLMOutfitResponse,
        allProducts: EnrichedProduct[],
    ): Promise<Array<{ name: string; reasoning: string; items: EnrichedProduct[] }>> {
        const productMap = new Map<string, EnrichedProduct>();
        allProducts.forEach(p => productMap.set(p.id, p));

        return llmResponse.outfits.map(outfit => {
            const items: EnrichedProduct[] = [];
            for (const itemId of outfit.item_ids) {
                const product = productMap.get(itemId);
                if (product) {
                    items.push(product);
                } else {
                    console.warn(`Product with ID ${itemId} not found in inventory`);
                }
            }

            return {
                name: outfit.name,
                reasoning: outfit.reasoning,
                items,
            };
        });
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


