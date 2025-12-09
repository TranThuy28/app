import * as fs from 'fs';
import * as path from 'path';
import type { EnrichedProduct } from './enricher.ts';

/**
 * Result interface for outfit suggestions
 */
export interface ProductGroup {
    key: string;
    title: string;
    items: EnrichedProduct[];
}

export interface OutfitResult {
    items: EnrichedProduct[];
    groups: ProductGroup[];
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
     * Loads all JSON files inside a category folder and returns them as groups.
     * Falls back to the legacy single-file structure if no folder is found.
     */
    private loadCategoryGroups(category: 'casual' | 'hanging' | 'office' | 'party'): ProductGroup[] {
        const folderPath = path.join(this.productsBasePath, category);
        const legacyFilePath = path.join(this.productsBasePath, `${category}.json`);

        const groups: ProductGroup[] = [];

        const humanize = (key: string) => {
            return key
                .replace(/[-_]+/g, ' ')
                .replace(/\s+/g, ' ')
                .trim()
                .replace(/\b\w/g, (c) => c.toUpperCase());
        };

        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const filePath = path.join(folderPath, file);
                try {
                    const raw = fs.readFileSync(filePath, 'utf-8');
                    const data = JSON.parse(raw);
                    if (Array.isArray(data)) {
                        const key = path.parse(file).name;
                        groups.push({
                            key,
                            title: humanize(key),
                            items: data as EnrichedProduct[],
                        });
                    } else {
                        console.warn(`Category file ${filePath} does not contain an array, skipping.`);
                    }
                } catch (error) {
                    console.error(`Error reading category file ${filePath}:`, error);
                }
            }
        }

        // Legacy fallback: single JSON file per category
        if (groups.length === 0 && fs.existsSync(legacyFilePath)) {
            try {
                const raw = fs.readFileSync(legacyFilePath, 'utf-8');
                const data = JSON.parse(raw);
                if (Array.isArray(data)) {
                    groups.push({
                        key: 'all',
                        title: 'All',
                        items: data as EnrichedProduct[],
                    });
                }
            } catch (error) {
                console.error(`Error reading legacy category file ${legacyFilePath}:`, error);
            }
        }

        return groups;
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

        // Step 2: Load all json files inside the mapped category folder
        const groups = this.loadCategoryGroups(category);
        const flattened = this.shuffle(groups.flatMap((g) => g.items));

        if (flattened.length === 0) {
            return {
                items: [],
                groups: [],
                category,
                message: `No products found in category ${category}`,
            };
        }

        return {
            items: flattened,
            groups,
            category,
            message: `Found ${flattened.length} item(s) across ${groups.length} group(s) for ${category}`,
        };
    }

    /**
     * Gets all available products in a category (for debugging/testing)
     */
    getAllProductsInCategory(category: 'casual' | 'hanging' | 'office' | 'party'): EnrichedProduct[] {
        return this.loadCategoryGroups(category).flatMap((g) => g.items);
    }

    /**
     * Deletes a product by id from a specific category file.
     */
    deleteProduct(category: 'casual' | 'hanging' | 'office' | 'party', productId: string): boolean {
        const folderPath = path.join(this.productsBasePath, category);
        const legacyFilePath = path.join(this.productsBasePath, `${category}.json`);
        let deleted = false;

        const tryDeleteInFile = (filePath: string) => {
            if (!fs.existsSync(filePath)) return false;
            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const data = JSON.parse(raw) as EnrichedProduct[];
                const filtered = data.filter((item) => item.id !== productId);
                if (filtered.length === data.length) return false;
                fs.writeFileSync(filePath, JSON.stringify(filtered, null, 2), 'utf-8');
                return true;
            } catch (error) {
                console.error(`Failed to delete product ${productId} from ${filePath}:`, error);
                return false;
            }
        };

        if (fs.existsSync(folderPath) && fs.statSync(folderPath).isDirectory()) {
            const files = fs.readdirSync(folderPath).filter((f) => f.endsWith('.json'));
            for (const file of files) {
                const filePath = path.join(folderPath, file);
                if (tryDeleteInFile(filePath)) {
                    deleted = true;
                    break;
                }
            }
        }

        if (!deleted) {
            deleted = tryDeleteInFile(legacyFilePath);
        }

        return deleted;
    }
}


