import puppeteer, { type Browser, type Page } from 'puppeteer';
import type { ProductVariation } from './enricher.ts';

/**
 * Initial crawler (Lite Version)
 * Gets all color names immediately, but only crawls images for the first 3 variations.
 * The rest are marked as pending (is_crawled: false, image_url: null).
 */
export async function crawlInitialVariations(url: string): Promise<ProductVariation[]> {
    let browser: Browser | null = null;

    try {
        console.log(`🚀 Starting initial crawl for: ${url}`);
        
        // Launch Puppeteer
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();
        
        // Set viewport
        await page.setViewport({ width: 1920, height: 1080 });
        
        // Navigate to product page
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

        // Try multiple common Amazon selectors for color/style variations
        const selectorCandidates = [
            '#variation_color_name li',
            '.twister-swatch-list li',
            '#variation_style_name li',
            '.a-button-toggle',
        ];

        // Extract all color/style names from variation containers
        const allColorNames = await page.evaluate((selectors: string[]) => {
            const seen = new Set<string>();
            const colorNames: string[] = [];

            for (const sel of selectors) {
                const elements = Array.from(document.querySelectorAll<HTMLElement>(sel));
                for (const el of elements) {
                    const img = el.querySelector('img');
                    let name = '';

                    if (img) {
                        name = (img.getAttribute('alt') || '').trim();
                    }

                    if (!name) {
                        name = (el.textContent || '').trim();
                    }

                    if (!name) continue;

                    const key = name.toLowerCase();
                    if (!seen.has(key)) {
                        seen.add(key);
                        colorNames.push(name);
                    }
                }
            }

            return colorNames;
        }, selectorCandidates);

        console.log(`📋 Found ${allColorNames.length} color variations`);

        if (allColorNames.length === 0) {
            return [];
        }

        const variations: ProductVariation[] = [];

        // Process first 3 items: click/hover, wait, get image
        for (let i = 0; i < Math.min(3, allColorNames.length); i++) {
            const colorName = allColorNames[i];
            console.log(`🖼️  Crawling image ${i + 1}/3 for color: ${colorName}`);

            try {
                // Find and click the variation item using the same selector strategy
                const clicked = await page.evaluate((index: number, selectors: string[]) => {
                    const seen = new Set<string>();
                    const uniqueElements: HTMLElement[] = [];

                    for (const sel of selectors) {
                        const elements = Array.from(document.querySelectorAll<HTMLElement>(sel));
                        for (const el of elements) {
                            const img = el.querySelector('img');
                            let name = '';

                            if (img) {
                                name = (img.getAttribute('alt') || '').trim();
                            }

                            if (!name) {
                                name = (el.textContent || '').trim();
                            }

                            if (!name) continue;

                            const key = name.toLowerCase();
                            if (!seen.has(key)) {
                                seen.add(key);
                                uniqueElements.push(el);
                            }
                        }
                    }

                    const target = uniqueElements[index];
                    if (target) {
                        (target as HTMLElement).click();
                        return true;
                    }
                    return false;
                }, i, selectorCandidates);

                if (!clicked) {
                    console.warn(`Could not click variation ${i + 1}`);
                    variations.push({
                        color_name: colorName,
                        image_url: null,
                        is_crawled: false,
                    });
                    continue;
                }

                // Wait for image to update
                await page.waitForTimeout(800);

                // Get the main product image
                const imageUrl = await page.evaluate(() => {
                    const landingImage = document.querySelector('#landingImage') as HTMLImageElement;
                    if (landingImage && landingImage.src) {
                        // Clean Amazon image URL (remove resizing parameters)
                        return landingImage.src.replace(/\._AC_.*?_/, '');
                    }
                    return null;
                });

                if (imageUrl) {
                    variations.push({
                        color_name: colorName,
                        image_url: imageUrl,
                        is_crawled: true,
                    });
                    console.log(`✅ Got image for ${colorName}`);
                } else {
                    variations.push({
                        color_name: colorName,
                        image_url: null,
                        is_crawled: false,
                    });
                    console.warn(`⚠️  Could not get image for ${colorName}`);
                }
            } catch (error) {
                console.error(`Error crawling variation ${i + 1}:`, error);
                variations.push({
                    color_name: colorName,
                    image_url: null,
                    is_crawled: false,
                });
            }
        }

        // Mark rest as pending
        for (let i = 3; i < allColorNames.length; i++) {
            variations.push({
                color_name: allColorNames[i],
                image_url: null,
                is_crawled: false,
            });
        }

        console.log(`✅ Initial crawl complete: ${variations.filter(v => v.is_crawled).length} crawled, ${variations.filter(v => !v.is_crawled).length} pending`);
        return variations;

    } catch (error) {
        console.error('Error in crawlInitialVariations:', error);
        throw error;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

/**
 * On-Demand Crawler (Targeted Version)
 * Fetches a specific color variation image by name.
 * Optimized for speed by blocking unnecessary resources.
 */
export async function crawlSpecificVariation(url: string, targetColorName: string): Promise<string | null> {
    let browser: Browser | null = null;

    try {
        console.log(`🎯 Fetching specific color: ${targetColorName} from ${url}`);

        // Launch Puppeteer with resource blocking for speed
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
        });

        const page = await browser.newPage();

        // Block CSS and Fonts to speed up (we need images for the URL, but can block other media)
        await page.setRequestInterception(true);
        page.on('request', (req) => {
            const resourceType = req.resourceType();
            // Block stylesheets and fonts, but allow images (we need the main product image)
            if (['stylesheet', 'font'].includes(resourceType)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        // Set viewport
        await page.setViewport({ width: 1920, height: 1080 });

        // Navigate to product page
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Wait for variation container
        await page.waitForSelector('#variation_color_name', { timeout: 10000 });

        // Find and click the matching color swatch (case-insensitive)
        const clicked = await page.evaluate((targetName) => {
            const container = document.querySelector('#variation_color_name');
            if (!container) return false;

            const items = container.querySelectorAll('li');
            for (let i = 0; i < items.length; i++) {
                const item = items[i];
                const img = item.querySelector('img');
                if (img) {
                    const altText = (img.getAttribute('alt') || '').toLowerCase().trim();
                    if (altText === targetName.toLowerCase().trim()) {
                        (item as HTMLElement).click();
                        return true;
                    }
                }
            }
            return false;
        }, targetColorName);

        if (!clicked) {
            console.warn(`Color variation "${targetColorName}" not found`);
            return null;
        }

        // Wait for image to update (longer wait for on-demand)
        await page.waitForTimeout(1000);

        // Get the main product image
        const imageUrl = await page.evaluate(() => {
            const landingImage = document.querySelector('#landingImage') as HTMLImageElement;
            if (landingImage && landingImage.src) {
                // Clean Amazon image URL (remove resizing parameters)
                return landingImage.src.replace(/\._AC_.*?_/, '');
            }
            return null;
        });

        if (imageUrl) {
            console.log(`✅ Successfully fetched image for ${targetColorName}`);
            return imageUrl;
        } else {
            console.warn(`⚠️  Could not get image URL for ${targetColorName}`);
            return null;
        }

    } catch (error) {
        console.error(`Error in crawlSpecificVariation for ${targetColorName}:`, error);
        return null;
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

