import * as dotenv from 'dotenv';
dotenv.config();

import { PlaywrightCrawler, log, RequestQueue } from 'crawlee';
import type { PlaywrightCrawlingContext } from 'crawlee';
import { firefox } from 'playwright';
import { handleCaptchaBlocking, extractProductDetails, extractDynamicData, type ProductDetails } from './scraper.ts';
import { enrichProduct } from './services/enricher.ts';
import type { EnrichedProduct } from './services/enricher.ts';
import { scrapeProductFast } from './scraper-fast.ts';
import { CookieManager } from './utils/cookie-manager.ts';
import * as fs from 'fs';
import * as path from 'path';

// Global cookie manager instance (initialized in run())
let cookieManager: CookieManager | null = null;

// Track background enrichment jobs so the process doesn't exit early
const activeProcessingPromises: Promise<void>[] = [];

type RawProductForEnrichment = ProductDetails & { product_url?: string };

/**
 * Append enriched products to per-category master JSON files.
 * Each category has a single file: storage/products/{category_folder}.json
 */
const appendEnrichedToCategoryFiles = async (products: EnrichedProduct[]): Promise<void> => {
    if (products.length === 0) return;

    const grouped: Record<string, EnrichedProduct[]> = {};
    for (const p of products) {
        if (!p.category_folder) continue;
        if (!grouped[p.category_folder]) grouped[p.category_folder] = [];
        grouped[p.category_folder].push(p);
    }

    for (const [category, items] of Object.entries(grouped)) {
        const categoryFilePath = path.join('storage', 'products', `${category}.json`);
        let existing: EnrichedProduct[] = [];

        if (fs.existsSync(categoryFilePath)) {
            try {
                const raw = fs.readFileSync(categoryFilePath, 'utf-8');
                existing = JSON.parse(raw) as EnrichedProduct[];
            } catch (error) {
                log.warning(`Failed to read existing category file ${categoryFilePath}, starting fresh.`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        const combined = existing.concat(items);
        fs.mkdirSync(path.dirname(categoryFilePath), { recursive: true });
        fs.writeFileSync(categoryFilePath, JSON.stringify(combined, null, 2), 'utf-8');

        log.info(`📦 Appended ${items.length} items to ${categoryFilePath} (total: ${combined.length})`);
    }
};

/**
 * Background job: enrich a batch of raw products using LLM in chunks of 5.
 * Fire-and-forget from the scraper; this function is awaited only at the very end.
 */
const processBatchInBackground = async (products: RawProductForEnrichment[]): Promise<void> => {
    if (products.length === 0) return;

    log.info(`🧠 Starting background enrichment for batch of ${products.length} products...`);

    const chunkSize = 5;
    for (let i = 0; i < products.length; i += chunkSize) {
        const chunk = products.slice(i, i + chunkSize);
        log.info(`Enriching chunk ${Math.floor(i / chunkSize) + 1}/${Math.ceil(products.length / chunkSize)} (${chunk.length} products)...`);

        const enrichedChunk = await Promise.all(
            chunk.map(async (raw) => {
                try {
                    const enriched = await enrichProduct(raw);
                    return enriched;
                } catch (error) {
                    log.error('Failed to enrich product in chunk', {
                        title: raw.title,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return null;
                }
            })
        );

        const validEnriched = enrichedChunk.filter((p): p is EnrichedProduct => p !== null);
        if (validEnriched.length > 0) {
            await appendEnrichedToCategoryFiles(validEnriched);
        }
    }

    log.info(`✅ Background enrichment completed for batch of ${products.length} products.`);
};

/**
 * Main request handler for the PlaywrightCrawler
 */
const requestHandler = async (context: PlaywrightCrawlingContext) => {
    const { request, page } = context;
    const { url, label = 'PRODUCT' } = request;

    log.info(`Processing ${label} request`, { url });

    try {
        // Wait for the page to load (reduced timeout for speed)
        try {
            await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
        } catch (timeoutError) {
            log.warning(`Page load timeout for ${url}, continuing anyway...`, {
                error: timeoutError instanceof Error ? timeoutError.message : String(timeoutError),
            });
        }
        
        // Reduced random delay for speed (500ms - 1000ms)
        const randomDelay = Math.random() * 500 + 500; // 500-1000ms
        log.info(`Waiting ${Math.round(randomDelay)}ms before extraction...`);
        await new Promise(r => setTimeout(r, randomDelay));
        
        if (label === 'CATEGORY') {
            // Reduced delay for speed (500-1000ms)
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 500 + 500));

            // Detect Amazon dog page / CAPTCHA
            const pageTitle = await page.title().catch(() => '');
            let pageContentSnippet = '';
            try {
                const rawContent = await page.content();
                pageContentSnippet = rawContent.slice(0, 2000).toLowerCase(); // small snippet for detection
            } catch {
                pageContentSnippet = '';
            }

            const isDogPage =
                (pageTitle && pageTitle.toLowerCase().includes('sorry')) ||
                pageContentSnippet.includes('sorry') ||
                pageContentSnippet.includes('dogs of amazon');

            if (isDogPage) {
                log.warning('🚨 AMAZON DOG PAGE DETECTED! Please manually reload the browser or solve the CAPTCHA to continue...');
                // Wait loop for human intervention
                while (true) {
                    await new Promise((resolve) => setTimeout(resolve, 5000));
                    const resultsExist = await page.$('[data-component-type="s-search-result"]');
                    if (resultsExist) {
                        log.info('Human intervention detected. Continuing with category scraping...');
                        break;
                    }
                    log.warning('Waiting for human intervention (page still blocked)...');
                }
            }

            // Wait for product grid using robust selector (reduced timeout for speed)
            await page.waitForSelector('[data-component-type="s-search-result"]', { timeout: 10000 })
                .catch(() => log.warning('Product grid not found via selector'));

            // Extract product links manually
            const productLinks = await page.$$eval('[data-component-type="s-search-result"]', (cards) => {
                return cards
                    .map((card) => {
                        const linkEl = card.querySelector('h2 a') || card.querySelector('a.s-no-outline');
                        return linkEl ? (linkEl as HTMLAnchorElement).href : null;
                    })
                    .filter((href): href is string => Boolean(href) && !href!.includes('/slredirect/'));
            });

            // Deduplicate links
            const uniqueLinks = [...new Set(productLinks)];
            log.info(`Found ${uniqueLinks.length} valid product links.`);

            // TURBO HYBRID STRATEGY + PARALLEL PIPELINE:
            // Use Axios + Cheerio for fast scraping of RAW products,
            // then launch background LLM enrichment jobs without blocking pagination.
            if (uniqueLinks.length > 0) {
                log.info(`🚀 Starting fast scraping of ${uniqueLinks.length} products (raw only, no images)...`);

                // Process in smaller batches (scraping only; enrichment is handled separately)
                const batchSize = 5;
                for (let i = 0; i < uniqueLinks.length; i += batchSize) {
                    const batch = uniqueLinks.slice(i, i + batchSize);
                    log.info(`Scraping batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(uniqueLinks.length / batchSize)} (${batch.length} products)...`);

                    const rawProductsForBatch: RawProductForEnrichment[] = [];

                    // Parallel scraping with Promise.all
                    const results = await Promise.all(
                        batch.map(async (productUrl) => {
                            try {
                                if (!cookieManager || cookieManager.getPoolSize() === 0) {
                                    log.warning(`No cookies available for ${productUrl}, skipping fast scrape...`);
                                    return { success: false, url: productUrl };
                                }

                                const randomCookies = cookieManager.getRandomCookie();
                                const productData = await scrapeProductFast(productUrl, randomCookies);

                                if (productData) {
                                    rawProductsForBatch.push({
                                        ...productData,
                                        product_url: productUrl,
                                    });
                                    return { success: true, url: productUrl };
                                } else {
                                    log.warning(`Failed to scrape product: ${productUrl}`);
                                    return { success: false, url: productUrl };
                                }
                            } catch (error) {
                                log.error(`Error scraping product ${productUrl}`, {
                                    error: error instanceof Error ? error.message : String(error),
                                });
                                return { success: false, url: productUrl };
                            }
                        })
                    );

                    const successCount = results.filter((r) => r.success).length;
                    log.info(`Batch scrape complete: ${successCount}/${batch.length} products scraped.`);

                    // Launch background enrichment job (FIRE & FORGET)
                    if (rawProductsForBatch.length > 0) {
                        const jobPromise = processBatchInBackground(rawProductsForBatch);
                        activeProcessingPromises.push(jobPromise);
                    }

                    // Small delay between batches to avoid rate limiting
                    if (i + batchSize < uniqueLinks.length) {
                        await new Promise((resolve) => setTimeout(resolve, 500));
                    }
                }

                log.info(`✅ Completed raw scraping for ${uniqueLinks.length} products on this page (enrichment running in background).`);
            }

            // Handle Pagination - Find and enqueue next page
            try {
                const nextPageUrl = await page.$eval('a.s-pagination-next', (el) => {
                    const anchor = el as HTMLAnchorElement;
                    return anchor.getAttribute('href');
                }).catch(() => null);

                if (nextPageUrl) {
                    // Amazon links are sometimes relative, resolve them
                    const absoluteUrl = new URL(nextPageUrl, url).toString();
                    
                    log.info(`➡️ Found Next Page: ${absoluteUrl}`);
                    await context.addRequests([{
                        url: absoluteUrl,
                        label: 'CATEGORY', // Keep loop going
                    }]);
                } else {
                    log.info('🛑 No more pages found (or Next button disabled).');
                }
            } catch (error) {
                log.warning('Failed to find next page', {
                    error: error instanceof Error ? error.message : String(error),
                });
            }

            return;
        }

        // For non-CATEGORY labels we currently do nothing (all work is done in CATEGORY pages)
    } catch (error) {
        // Check if it's a timeout error
        const errorMessage = error instanceof Error ? error.message : String(error);
        if (errorMessage.includes('timeout') || errorMessage.includes('Timeout')) {
            log.warning(`Timeout error scraping product page (non-fatal)`, {
                url,
                error: errorMessage,
            });
            // Don't throw for timeout errors - allow the crawler to continue
            return;
        }
        
        // For other errors (like captcha), log and rethrow
        log.error(`Error scraping product page`, {
            url,
            error: errorMessage,
        });
        throw error;
    }
};

/**
 * Initialize and run the crawler
 */
const run = async () => {
    // Initialize Cookie Manager and load all cookie profiles
    cookieManager = new CookieManager();
    const cookiesLoaded = cookieManager.loadAllCookies('cookies');
    
    if (cookiesLoaded === 0) {
        log.warning('⚠️  No cookies loaded! Scraping may fail due to bot detection.');
    }

    // Initialize the PlaywrightCrawler
    const crawler = new PlaywrightCrawler({
        requestHandler,
        // Use Chromium browser with visible window for debugging
        launchContext: {
            launcher: firefox, // Switch to Firefox browser
            launchOptions: {
                headless: false, // Visible browser for manual intervention
                // Firefox handles sandboxing differently; no Chrome-specific args needed
            },
        },
        // Reduce navigation timeout for speed
        navigationTimeoutSecs: 30,
        // Stealth options to make the bot look more like a real user
        browserPoolOptions: {
            useFingerprints: true, // Use browser fingerprints to avoid detection
        },
        // Increase concurrency for maximum speed
        maxConcurrency: 5,
        maxRequestsPerCrawl: 500, // Increased to allow pagination across multiple pages
        preNavigationHooks: [
            async (hookContext, gotoOptions) => {
                const { page } = hookContext as PlaywrightCrawlingContext;
                const browserContext = (hookContext as PlaywrightCrawlingContext).context as import('playwright').BrowserContext;

                // Block heavy resources (images, CSS, fonts, videos, analytics) for speed
                await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,css,woff,woff2,mp4,ttf}', (route) => {
                    route.abort();
                });
                await page.route('**/*google-analytics*', (route) => route.abort());
                await page.route('**/*doubleclick*', (route) => route.abort());
                await page.route('**/*googlesyndication*', (route) => route.abort());

                // Randomize viewport size to mimic different users
                const randomWidth = Math.floor(Math.random() * (1920 - 1366 + 1)) + 1366;
                const randomHeight = Math.floor(Math.random() * (1080 - 768 + 1)) + 768;
                await page.setViewportSize({ width: randomWidth, height: randomHeight });
                await page.setExtraHTTPHeaders({
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'sec-ch-ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
                    'sec-ch-ua-mobile': '?0',
                    'sec-ch-ua-platform': '"Windows"',
                    'Upgrade-Insecure-Requests': '1',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                });

                // Inject random cookie from pool (rotation strategy)
                try {
                    if (cookieManager && cookieManager.getPoolSize() > 0) {
                        const randomCookies = cookieManager.getRandomCookie();
                        const validCookies = CookieManager.toPlaywrightCookies(randomCookies);
                        
                        if (validCookies.length > 0 && browserContext) {
                            await browserContext.addCookies(validCookies);
                            log.debug(`Injected random cookie profile (${validCookies.length} cookies)`);
                        }
                    }
                } catch (error) {
                    log.warning('Cookie injection failed', {
                        error: error instanceof Error ? error.message : String(error),
                    });
                }
            },
        ],
        // Optional: Add proxy configuration to avoid blocking
        // proxyConfiguration: new ProxyConfiguration({
        //     groups: ['RESIDENTIAL'],
        //     countryCode: 'US',
        // }),
    });

    // Sample Amazon category/search URL
    const startUrl = 'https://www.amazon.com/s?k=going+out&crid=3I0XLFKHB0SYQ&sprefix=going+out%2Caps%2C397&ref=nb_sb_noss_2';

    log.info('Starting crawler...', { startUrl });

    // Run the crawler with labeled seed request
    await crawler.run([
        {
            url: startUrl,
            label: 'CATEGORY',
        },
    ]);

    log.info('Crawler finished! Waiting for background enrichment jobs to complete...');

    // Wait for all background enrichment jobs
    if (activeProcessingPromises.length > 0) {
        await Promise.all(activeProcessingPromises);
        log.info('All background enrichment jobs completed.');
    } else {
        log.info('No background enrichment jobs were scheduled.');
    }
};

// Run the scraper
run().catch((error) => {
    log.error('Error running crawler:', error);
    process.exit(1);
});
