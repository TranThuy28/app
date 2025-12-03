import * as fs from 'fs';
import * as path from 'path';
import type { EnrichedProduct } from './enricher.ts';

/**
 * Result interface for outfit suggestions
 */
export interface OutfitResult {
    items: EnrichedProduct[];
    category: 'di_lam' | 'di_choi' | 'di_an' | 'di_tiec';
    message: string;
}

/**
 * Simple Stylist service for retrieving and suggesting outfits
 */
export class SimpleStylist {
    private readonly productsBasePath = path.join('storage', 'products');

    /**
     * Maps user message keywords to category folder
     */
    private mapMessageToCategory(userMessage: string): 'di_lam' | 'di_choi' | 'di_an' | 'di_tiec' {
        const lowerMessage = userMessage.toLowerCase();

        // di_lam: Work/Office keywords
        const diLamKeywords = ['họp', 'công sở', 'đi làm', 'work', 'office', 'business', 'professional', 'corporate'];
        if (diLamKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'di_lam';
        }

        // di_tiec: Party/Wedding keywords
        const diTiecKeywords = ['cưới', 'tiệc', 'party', 'prom', 'sang trọng', 'wedding', 'event', 'formal', 'evening'];
        if (diTiecKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'di_tiec';
        }

        // di_an: Dining/Date keywords
        const diAnKeywords = ['hẹn hò', 'ăn tối', 'nhà hàng', 'dinner', 'date', 'dining', 'restaurant', 'brunch'];
        if (diAnKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'di_an';
        }

        // di_choi: Casual/Street keywords
        const diChoiKeywords = ['cà phê', 'dạo phố', 'bạn bè', 'street', 'casual', 'everyday', 'daily'];
        if (diChoiKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'di_choi';
        }

        // Default to di_choi
        return 'di_choi';
    }

    /**
     * Reads all product IDs from a category folder
     */
    private getProductIds(category: string): string[] {
        const categoryPath = path.join(this.productsBasePath, category);
        
        if (!fs.existsSync(categoryPath)) {
            return [];
        }

        try {
            const items = fs.readdirSync(categoryPath, { withFileTypes: true });
            return items
                .filter(item => item.isDirectory())
                .map(item => item.name);
        } catch (error) {
            console.error(`Error reading category folder ${category}:`, error);
            return [];
        }
    }

    /**
     * Loads a product from its JSON file
     */
    private loadProduct(category: string, productId: string): EnrichedProduct | null {
        const productPath = path.join(this.productsBasePath, category, productId, 'data.json');
        
        if (!fs.existsSync(productPath)) {
            return null;
        }

        try {
            const fileContent = fs.readFileSync(productPath, 'utf-8');
            return JSON.parse(fileContent) as EnrichedProduct;
        } catch (error) {
            console.error(`Error loading product ${productId}:`, error);
            return null;
        }
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
     * Suggests an outfit based on user message
     */
    async suggestOutfit(userMessage: string): Promise<OutfitResult> {
        // Step 1: Map message to category
        const category = this.mapMessageToCategory(userMessage);

        // Step 2: Get all product IDs in that category
        const productIds = this.getProductIds(category);

        if (productIds.length === 0) {
            return {
                items: [],
                category,
                message: `No products found in category ${category}`,
            };
        }

        // Step 3: Load all products and categorize them
        const allProducts: EnrichedProduct[] = [];
        const tops: EnrichedProduct[] = [];
        const bottoms: EnrichedProduct[] = [];
        const dresses: EnrichedProduct[] = [];
        const sets: EnrichedProduct[] = [];

        for (const productId of productIds) {
            const product = this.loadProduct(category, productId);
            if (product) {
                allProducts.push(product);
                
                switch (product.category_main) {
                    case 'top':
                    case 'outerwear':
                        tops.push(product);
                        break;
                    case 'bottom':
                        bottoms.push(product);
                        break;
                    case 'dress':
                        dresses.push(product);
                        break;
                    case 'set':
                        sets.push(product);
                        break;
                }
            }
        }

        // Step 4: Build full list of products for this category
        const itemsWithPaths = allProducts.map(item => {
            const imagePath = path.join('storage', 'products', category, item.id, '1.jpg');
            return {
                ...item,
                image_url: imagePath.replace(/\\/g, '/'), // Normalize path separators
            };
        });

        return {
            items: itemsWithPaths,
            category,
            message: `Found ${itemsWithPaths.length} item(s) for ${category}`,
        };
    }

    /**
     * Gets all available products in a category (for debugging/testing)
     */
    getAllProductsInCategory(category: 'di_lam' | 'di_choi' | 'di_an' | 'di_tiec'): EnrichedProduct[] {
        const productIds = this.getProductIds(category);
        const products: EnrichedProduct[] = [];

        for (const productId of productIds) {
            const product = this.loadProduct(category, productId);
            if (product) {
                products.push(product);
            }
        }

        return products;
    }
}


