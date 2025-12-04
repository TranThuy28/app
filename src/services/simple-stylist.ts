import * as fs from 'fs';
import * as path from 'path';
import type { EnrichedProduct } from './enricher.ts';

/**
 * Result interface for outfit suggestions
 */
export interface OutfitResult {
    items: EnrichedProduct[];
    category: 'casual' | 'hanging' | 'office' | 'party';
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
    private mapMessageToCategory(userMessage: string): 'casual' | 'hanging' | 'office' | 'party' {
        const lowerMessage = userMessage.toLowerCase();

        // office keywords
        const officeKeywords = ['họp', 'công sở', 'đi làm', 'work', 'office', 'business', 'professional', 'corporate', 'formal', 'trousers', 'blazer'];
        if (officeKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'office';
        }

        // party keywords
        const partyKeywords = ['cưới', 'tiệc', 'party', 'prom', 'sang trọng', 'wedding', 'event', 'evening', 'cocktail', 'gala'];
        if (partyKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'party';
        }

        // hanging (dining/date) keywords
        const hangingKeywords = ['tops','club', 'night', 'night out','ăn tối', 'elegant', 'dinner', 'date', 'dining', 'restaurant', 'brunch', 'eat', 'hanging', "going out", 'going'];
        if (hangingKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'hanging';
        }

        // casual/street keywords
        const casualKeywords = ['cà phê', 'dạo phố', 'bạn bè', 'street', 'casual', 'everyday', 'daily', 'đi chơi', 'chơi', 'phố', 'streetwear'];
        if (casualKeywords.some(keyword => lowerMessage.includes(keyword))) {
            return 'casual';
        }

        // Default to casual
        return 'hanging';
    }

    /**
     * Loads all products for a category from its JSON file.
     */
    private loadCategory(category: 'casual' | 'hanging' | 'office' | 'party'): EnrichedProduct[] {
        const filePath = path.join(this.productsBasePath, `${category}.json`);

        if (!fs.existsSync(filePath)) {
            return [];
        }

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw);
            if (Array.isArray(data)) {
                return data as EnrichedProduct[];
            }
            console.warn(`Category file ${filePath} does not contain an array.`);
            return [];
        } catch (error) {
            console.error(`Error reading category file ${filePath}:`, error);
            return [];
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

        // Step 2: Load the entire category JSON
        const products = this.loadCategory(category);

        if (products.length === 0) {
            return {
                items: [],
                category,
                message: `No products found in category ${category}`,
            };
        }

        const shuffled = this.shuffle(products);

        return {
            items: shuffled,
            category,
            message: `Found ${products.length} item(s) for ${category}`,
        };
    }

    /**
     * Gets all available products in a category (for debugging/testing)
     */
    getAllProductsInCategory(category: 'casual' | 'hanging' | 'office' | 'party'): EnrichedProduct[] {
        return this.loadCategory(category);
    }

    /**
     * Deletes a product by id from a specific category file.
     */
    deleteProduct(category: 'casual' | 'hanging' | 'office' | 'party', productId: string): boolean {
        const filePath = path.join(this.productsBasePath, `${category}.json`);

        if (!fs.existsSync(filePath)) {
            return false;
        }

        try {
            const raw = fs.readFileSync(filePath, 'utf-8');
            const data = JSON.parse(raw) as EnrichedProduct[];
            const filtered = data.filter((item) => item.id !== productId);

            if (filtered.length === data.length) {
                return false; // no product removed
            }

            fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
            return true;
        } catch (error) {
            console.error(`Failed to delete product ${productId} from ${category}:`, error);
            return false;
        }
    }
}


