import * as dotenv from 'dotenv';
dotenv.config();

import { PlaywrightCrawler, log, RequestQueue } from 'crawlee';
import type { PlaywrightCrawlingContext } from 'crawlee';
import { firefox } from 'playwright';
import { handleCaptchaBlocking, extractProductDetails, extractDynamicData } from './scraper.ts';
import { enrichProductData } from './services/enricher.ts';
import type { EnrichedProduct } from './services/enricher.ts';
import { downloadImage } from './utils/image-downloader.ts';
import * as fs from 'fs';
import * as path from 'path';


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

            // Manually add product links to queue
            const requestQueue = (context as PlaywrightCrawlingContext & { requestQueue?: RequestQueue }).requestQueue;
            if (uniqueLinks.length > 0) {
                log.info(`Enqueuing ${uniqueLinks.length} products...`);
                await context.addRequests(
                    uniqueLinks.map((url) => ({
                        url,
                        label: 'PRODUCT',
                    }))
                );
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

        // PRODUCT label: run scraping workflow

        // Wait for product details section (reduced timeout for speed)
        try {
            await page.waitForSelector('#productOverview_feature_div', { timeout: 5000 })
                .catch(() => log.info('Product details section not found, continuing...'));
        } catch (error) {
            log.warning('Timeout waiting for product details section', {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        // Also wait for feature bullets (reduced timeout for speed)
        try {
            await page.waitForSelector('#feature-bullets', { timeout: 5000 })
                .catch(() => log.info('Feature bullets section not found, continuing...'));
        } catch (error) {
            log.warning('Timeout waiting for feature bullets section', {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        // Parse the rendered HTML with Cheerio
        const $ = await context.parseWithCheerio();

        // Check for captcha blocking
        handleCaptchaBlocking($);

        // Extract dynamic data using Playwright (handles Fashion layout)
        let dynamicData;
        try {
            dynamicData = await extractDynamicData(page);
            log.info('Dynamic data extracted', {
                productDetailsCount: Object.keys(dynamicData.productDetails).length,
                aboutThisItemCount: dynamicData.aboutThisItem.length,
            });
        } catch (error) {
            log.warning('Failed to extract dynamic data, continuing with static data only', {
                error: error instanceof Error ? error.message : String(error),
            });
            dynamicData = { productDetails: {}, aboutThisItem: [] };
        }

        // Step 1: Scrape Raw Data (merge static and dynamic)
        const rawProduct = extractProductDetails($, dynamicData);
        log.info('Raw product data extracted', {
            title: rawProduct.title,
            price: rawProduct.price,
            imageCount: rawProduct.imageUrls.length,
            productDetailsCount: Object.keys(rawProduct.productDetails).length,
            aboutThisItemCount: rawProduct.aboutThisItem.length,
        });

        // Step 2: Enrich Data (Rule-Based, Synchronous - No API call)
        let enrichedProduct: EnrichedProduct;
        try {
            enrichedProduct = enrichProductData(rawProduct, url); // Synchronous call, no await needed
            log.info('Product data enriched successfully (rule-based)', {
                id: enrichedProduct.id,
                category: enrichedProduct.category_main,
                category_folder: enrichedProduct.category_folder,
                brand: enrichedProduct.brand,
            });
        } catch (enrichError) {
            log.error('Failed to enrich product data', {
                url,
                error: enrichError instanceof Error ? enrichError.message : String(enrichError),
            });
            
            // Save to failed folder if enrichment fails
            const failedFolder = path.join('storage', 'products', 'failed');
            if (!fs.existsSync(failedFolder)) {
                fs.mkdirSync(failedFolder, { recursive: true });
            }
            const failedFilePath = path.join(failedFolder, `failed-${Date.now()}.json`);
            fs.writeFileSync(failedFilePath, JSON.stringify(rawProduct, null, 2), 'utf-8');
            log.warning(`Saved failed product to ${failedFilePath}`);
            return; // Skip further processing
        }

        // Step 3: Determine Storage Path (using category_folder from enriched data)
        const productFolder = path.join('products', enrichedProduct.category_folder, enrichedProduct.id);
        const fullProductPath = path.join('storage', productFolder);
        
        // Ensure the folder exists
        if (!fs.existsSync(fullProductPath)) {
            fs.mkdirSync(fullProductPath, { recursive: true });
        }
        
        log.info(`Product folder: ${productFolder}`);

        // Step 4: Download Images
        const imageUrls = rawProduct.imageUrls.slice(0, 5); // Limit to top 5
        const downloadedImagePaths: string[] = [];

        for (let i = 0; i < imageUrls.length; i++) {
            const imageUrl = imageUrls[i];
            if (!imageUrl) continue;

            // Clean the image URL (remove query parameters that might cause issues)
            const cleanUrl = imageUrl.split('?')[0];
            
            const localPath = await downloadImage(cleanUrl, productFolder, i + 1);
            if (localPath) {
                downloadedImagePaths.push(localPath);
            }
        }

        // Update enriched product with first image path
        if (downloadedImagePaths.length > 0) {
            enrichedProduct.image_url = downloadedImagePaths[0];
        }

        // Step 5: Save JSON
        const jsonFilePath = path.join(fullProductPath, 'data.json');
        fs.writeFileSync(jsonFilePath, JSON.stringify(enrichedProduct, null, 2), 'utf-8');
        log.info(`Saved enriched product data to ${jsonFilePath}`);

        // Push data to dataset (backup summary log)
        await context.pushData(enrichedProduct);

        log.info(`Successfully scraped and enriched product`, {
            id: enrichedProduct.id,
            title: enrichedProduct.title,
            brand: enrichedProduct.brand,
            category: enrichedProduct.category_main,
            price: enrichedProduct.price,
            imageCount: downloadedImagePaths.length,
            jsonPath: jsonFilePath,
        });
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

                // Inject real user cookies if available
                try {
                    const cookieFilePath = path.join(process.cwd(), 'amazon_cookies.json');
                    if (fs.existsSync(cookieFilePath)) {
                        const cookiesString = fs.readFileSync(cookieFilePath, 'utf8');
                        const rawCookies = JSON.parse(cookiesString);
                        const validCookies = rawCookies.map((cookie: any) => {
                            const mappedCookie: any = {
                                name: cookie.name,
                                value: cookie.value,
                                domain: cookie.domain || '.amazon.com',
                                path: cookie.path || '/',
                                secure: cookie.secure,
                                httpOnly: cookie.httpOnly,
                            };

                            if (cookie.sameSite === 'no_restriction') mappedCookie.sameSite = 'None';
                            else if (cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax') mappedCookie.sameSite = cookie.sameSite;

                            if (cookie.expirationDate) mappedCookie.expires = cookie.expirationDate;

                            return mappedCookie;
                        });
                        if (validCookies.length > 0 && browserContext) {
                            await browserContext.addCookies(validCookies);
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
    const startUrl = 'https://www.amazon.com/s?k=formal+wear&crid=1G5RGS7KT1O7E&sprefix=formal+we%2Caps%2C402&ref=nb_sb_noss_2';

    log.info('Starting crawler...', { startUrl });

    // Run the crawler with labeled seed request
    await crawler.run([
        {
            url: startUrl,
            label: 'CATEGORY',
        },
    ]);

    log.info('Crawler finished!');
};

// Run the scraper
run().catch((error) => {
    log.error('Error running crawler:', error);
    process.exit(1);
});
