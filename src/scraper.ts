import type { PlaywrightCrawlingContext } from 'crawlee';
import type { Page } from 'playwright';
import { parseNumberFromSelector } from './utils.ts';

// Use the Cheerio type from PlaywrightCrawlingContext's parseWithCheerio
type CheerioAPI = Awaited<ReturnType<PlaywrightCrawlingContext['parseWithCheerio']>>;

/**
 * CSS selectors for Amazon product page elements
 */
export const SELECTORS = {
    TITLE: 'span#productTitle',
    PRICE: 'span.priceToPay',
    IMAGES: '#altImages .item img',
    CAPTCHA: '[action="/errors/validateCaptcha"]',
    SIZE: '#inline-twister-expanded-dimension-text-size_name, #variation_size_name .selection',
    // Product details: prioritize Product Overview Table (Fabric type, Care instructions, etc.)
    PRODUCT_DETAILS: '#productOverview_feature_div tr',
    // About this item: standard bullets and alternative description sections
    ABOUT_THIS_ITEM: '#feature-bullets ul li span.a-list-item, #productDescription p, .aplus-v2 .aplus-p1',
} as const;

/**
 * Cleans Amazon image URL by removing resizing parameters to get high-resolution version.
 * @param url - The Amazon image URL with resizing parameters
 * @returns Cleaned URL without resizing parameters
 */
const cleanImageUrl = (url: string): string => {
    // Remove Amazon resizing suffix (e.g., ._AC_SR38,50_ or ._AC_UX679_)
    // Pattern: ._AC followed by any characters until the next underscore and file extension
    return url.replace(/\._AC_.*?_/, '');
};

/**
 * Extracts all product image URLs from the page and returns high-resolution versions.
 * Removes Amazon resizing parameters and ensures unique URLs.
 * @param $ - Cheerio instance
 * @returns Array of unique high-resolution image URL strings
 */
export const extractImageUrls = ($: CheerioAPI): string[] => {
    const imageUrlSet = new Set<string>();
    
    $(SELECTORS.IMAGES).each((_, element) => {
        const src = $(element).attr('src');
        if (src) {
            // Clean the URL immediately to get high-resolution version
            const cleanedUrl = cleanImageUrl(src);
            // Add to Set to ensure uniqueness
            imageUrlSet.add(cleanedUrl);
        }
    });
    
    // Convert Set to Array and return
    return Array.from(imageUrlSet);
};

/**
 * Extracts the currently selected size from the product page.
 * @param $ - Cheerio instance
 * @returns The size string, or undefined if not found
 */
export const extractSize = ($: CheerioAPI): string | undefined => {
    const sizeElement = $(SELECTORS.SIZE).first();
    if (sizeElement.length > 0) {
        const size = sizeElement.text().trim();
        return size || undefined;
    }
    return undefined;
};

/**
 * Cleans text by removing extra whitespace and newlines.
 * @param text - Raw text to clean
 * @returns Cleaned text
 */
const cleanText = (text: string): string => {
    return text.replace(/\s+/g, ' ').trim();
};

/**
 * Checks if a key should be blacklisted (Technical Details, not Product Specifications).
 * @param key - The key to check
 * @returns True if the key should be excluded
 */
const isBlacklistedKey = (key: string): boolean => {
    const lowerKey = key.toLowerCase();
    const blacklist = [
        'asin',
        'best sellers rank',
        'customer reviews',
        'date first available',
    ];
    return blacklist.some(term => lowerKey.includes(term));
};

/**
 * Removes JavaScript code from text.
 * @param text - Text that may contain JavaScript
 * @returns Cleaned text without JavaScript
 */
const removeJavaScript = (text: string): string => {
    // Remove common JavaScript patterns
    let cleaned = text;
    
    // Remove JavaScript variable declarations
    cleaned = cleaned.replace(/var\s+\w+\s*[=;].*?;/g, '');
    
    // Remove function calls that look like code
    cleaned = cleaned.replace(/function\s*\([^)]*\)\s*\{[^}]*\}/g, '');
    
    // Remove lines that start with common JS patterns
    cleaned = cleaned.split('\n')
        .filter(line => {
            const trimmed = line.trim();
            return !trimmed.startsWith('var ') &&
                   !trimmed.startsWith('function') &&
                   !trimmed.startsWith('if (') &&
                   !trimmed.includes('dpAcr') &&
                   !trimmed.includes('registerArcLink');
        })
        .join('\n');
    
    return cleanText(cleaned);
};

/**
 * Extracts dynamic product data using Playwright's page.evaluate()
 * This handles different Amazon layouts (Fashion vs Electronics) with multiple fallback strategies
 * @param page - Playwright Page object
 * @returns Object containing productDetails and aboutThisItem
 */
export const extractDynamicData = async (page: Page): Promise<{
    productDetails: Record<string, string>;
    aboutThisItem: string[];
}> => {
    const result = await page.evaluate(() => {
        const cleanText = (text: string): string => {
            return text.replace(/\s+/g, ' ').trim();
        };

        const isBlacklistedKey = (key: string): boolean => {
            const lowerKey = key.toLowerCase();
            const blacklist = ['asin', 'best sellers rank', 'customer reviews', 'date first available'];
            return blacklist.some(term => lowerKey.includes(term));
        };

        const removeJavaScript = (text: string): string => {
            let cleaned = text;
            cleaned = cleaned.replace(/var\s+\w+\s*[=;].*?;/g, '');
            cleaned = cleaned.replace(/function\s*\([^)]*\)\s*\{[^}]*\}/g, '');
            cleaned = cleaned.split('\n')
                .filter(line => {
                    const trimmed = line.trim();
                    return !trimmed.startsWith('var ') &&
                           !trimmed.startsWith('function') &&
                           !trimmed.startsWith('if (') &&
                           !trimmed.includes('dpAcr') &&
                           !trimmed.includes('registerArcLink');
                })
                .join('\n');
            return cleanText(cleaned);
        };

        const isUIElement = (text: string): boolean => {
            const lowerText = text.toLowerCase();
            const uiPatterns = ['show more', 'show less', 'see more', 'see less', 'read more', 'read less', 'expand', 'collapse', 'click'];
            return uiPatterns.some(pattern => lowerText.includes(pattern));
        };

        const isShippingWarning = (text: string): boolean => {
            const lowerText = text.toLowerCase();
            const warningPatterns = ['note:', 'clothing may wrinkle', 'shipping', 'delivery', 'packaging', 'may vary'];
            return warningPatterns.some(pattern => lowerText.includes(pattern)) && 
                   (lowerText.startsWith('note:') || text.length < 50);
        };

        // Extract productDetails with multiple strategies
        const productDetails: Record<string, string> = {};

        // Strategy 1: Amazon Fashion Layout - #productFactsDesktopExpander with specific structure
        const container = document.querySelector('#productFactsDesktopExpander');
        if (container) {
            // Find the "Product details" header
            const detailsHeader = Array.from(container.querySelectorAll('h3')).find(
                el => cleanText(el.textContent || '') === 'Product details'
            );
            
            if (detailsHeader) {
                // The list is usually the next sibling div with role="list" or class="a-section"
                let sibling = detailsHeader.nextElementSibling;
                while (sibling) {
                    if (sibling.tagName === 'DIV' && 
                        (sibling.getAttribute('role') === 'list' || 
                         sibling.classList.contains('a-section'))) {
                        
                        // Try to find rows inside this list div
                        const rows = sibling.querySelectorAll('.a-row, .a-list-item, div[class*="row"], div[class*="item"]');
                        
                        if (rows.length > 0) {
                            rows.forEach((row) => {
                                const cols = row.querySelectorAll('span, div');
                                if (cols.length >= 2) {
                                    let key = cleanText(cols[0].textContent || '').replace(/[:：]$/, '');
                                    let value = cleanText(cols[1].textContent || '');
                                    
                                    if (key && value && !isBlacklistedKey(key)) {
                                        value = removeJavaScript(value);
                                        if (value && value.length > 0) {
                                            productDetails[key] = value;
                                        }
                                    }
                                }
                            });
                        } else {
                            // Fallback: Try to parse text content if it's structured text
                            const text = cleanText(sibling.textContent || '');
                            if (text) {
                                // Try to split by newlines or common separators
                                const lines = text.split(/\n+/).filter(line => line.trim().length > 0);
                                lines.forEach((line) => {
                                    const colonIndex = line.indexOf(':');
                                    if (colonIndex > 0) {
                                        const key = line.substring(0, colonIndex).trim().replace(/[:：]$/, '');
                                        let value = line.substring(colonIndex + 1).trim();
                                        
                                        if (key && value && !isBlacklistedKey(key)) {
                                            value = removeJavaScript(value);
                                            if (value && value.length > 0) {
                                                productDetails[key] = value;
                                            }
                                        }
                                    }
                                });
                            }
                        }
                        break;
                    }
                    sibling = sibling.nextElementSibling;
                }
            }
        }

        // Strategy 2: Standard Table - #productOverview_feature_div tr
        if (Object.keys(productDetails).length === 0) {
            const tableRows = document.querySelectorAll('#productOverview_feature_div tr');
            tableRows.forEach((row) => {
                const firstCell = row.querySelector('td:first-child span, td:first-child');
                const lastCell = row.querySelector('td:last-child span, td:last-child');
                
                if (firstCell && lastCell) {
                    const key = cleanText(firstCell.textContent || '');
                    let value = cleanText(lastCell.textContent || '');
                    
                    if (key && !isBlacklistedKey(key)) {
                        value = removeJavaScript(value);
                        if (value && value.length > 0) {
                            productDetails[key] = value;
                        }
                    }
                }
            });
        }

        // Strategy 3: List - #detailBullets_feature_div li
        if (Object.keys(productDetails).length === 0) {
            const listItems = document.querySelectorAll('#detailBullets_feature_div li');
            listItems.forEach((li) => {
                const text = cleanText(li.textContent || '');
                const colonIndex = text.indexOf(':');
                if (colonIndex > 0) {
                    const key = text.substring(0, colonIndex).trim();
                    let value = text.substring(colonIndex + 1).trim();
                    
                    if (key && !isBlacklistedKey(key)) {
                        value = removeJavaScript(value);
                        if (value && value.length > 0) {
                            productDetails[key] = value;
                        }
                    }
                }
            });
        }

        // Extract aboutThisItem with multiple strategies
        const aboutItems: string[] = [];
        const seenTexts = new Set<string>();

        // Strategy 1: Amazon Fashion Layout - #productFactsDesktopExpander with "About this item" header
        if (container) {
            // Find the "About this item" header
            const aboutHeader = Array.from(container.querySelectorAll('h3')).find(
                el => cleanText(el.textContent || '').toLowerCase() === 'about this item'
            );
            
            if (aboutHeader) {
                // The bullet list is the next sibling UL
                // Sometimes there is an <hr> in between, so we look for the next UL specifically
                let sibling = aboutHeader.nextElementSibling;
                while (sibling) {
                    if (sibling.tagName === 'UL') {
                        const items = sibling.querySelectorAll('li');
                        items.forEach((li) => {
                            const text = cleanText(li.textContent || '');
                            if (text && text.length >= 10 && !isUIElement(text) && !isShippingWarning(text) && !seenTexts.has(text)) {
                                aboutItems.push(text);
                                seenTexts.add(text);
                            }
                        });
                        break;
                    }
                    sibling = sibling.nextElementSibling;
                }
            }
        }

        // Strategy 2: Standard - #feature-bullets li span.a-list-item
        if (aboutItems.length === 0) {
            const standardBullets = document.querySelectorAll('#feature-bullets li span.a-list-item');
            if (standardBullets.length > 0) {
                standardBullets.forEach((span) => {
                    const li = span.closest('li');
                    if (li) {
                        const text = cleanText(li.textContent || '');
                        if (text && text.length >= 10 && !isUIElement(text) && !isShippingWarning(text) && !seenTexts.has(text)) {
                            aboutItems.push(text);
                            seenTexts.add(text);
                        }
                    }
                });
            }
        }

        // Strategy 3: Expander/Hidden - Find "About this item" header and adjacent content (fallback)
        if (aboutItems.length === 0) {
            const headers = Array.from(document.querySelectorAll('h1, h2, h3, b, strong'));
            for (const header of headers) {
                const headerText = cleanText(header.textContent || '').toLowerCase();
                if (headerText.includes('about this item')) {
                    // Look for adjacent ul or div with content
                    let current = header.nextElementSibling;
                    while (current) {
                        if (current.tagName === 'UL') {
                            const listItems = current.querySelectorAll('li');
                            listItems.forEach((li) => {
                                const text = cleanText(li.textContent || '');
                                if (text && text.length >= 10 && !isUIElement(text) && !isShippingWarning(text) && !seenTexts.has(text)) {
                                    aboutItems.push(text);
                                    seenTexts.add(text);
                                }
                            });
                            break;
                        }
                        current = current.nextElementSibling;
                    }
                    break;
                }
            }
        }

        // Strategy 3: Class search - .a-expander-content ul li
        if (aboutItems.length === 0) {
            const expanderItems = document.querySelectorAll('.a-expander-content ul li');
            expanderItems.forEach((li) => {
                const text = cleanText(li.textContent || '');
                if (text && text.length >= 10 && !isUIElement(text) && !isShippingWarning(text) && !seenTexts.has(text)) {
                    aboutItems.push(text);
                    seenTexts.add(text);
                }
            });
        }

        return {
            productDetails,
            aboutThisItem: aboutItems,
        };
    });

    return result;
};

/**
 * Checks if text looks like a "Show more" button or similar UI element.
 * @param text - Text to check
 * @returns True if text appears to be a UI button/link
 */
const isUIElement = (text: string): boolean => {
    const lowerText = text.toLowerCase();
    const uiPatterns = [
        'show more',
        'show less',
        'see more',
        'see less',
        'read more',
        'read less',
        'expand',
        'collapse',
        'click',
    ];
    return uiPatterns.some(pattern => lowerText.includes(pattern));
};

/**
 * Checks if text is a shipping warning or note that should be excluded.
 * @param text - Text to check
 * @returns True if text should be excluded
 */
const isShippingWarning = (text: string): boolean => {
    const lowerText = text.toLowerCase();
    const warningPatterns = [
        'note:',
        'clothing may wrinkle',
        'shipping',
        'delivery',
        'packaging',
        'may vary',
    ];
    return warningPatterns.some(pattern => lowerText.includes(pattern)) && 
           (lowerText.startsWith('note:') || text.length < 50);
};


/**
 * Product details interface
 */
export interface ProductDetails {
    title: string;
    price: number;
    imageUrls: string[];
    size?: string;
    productDetails: Record<string, string>;
    aboutThisItem: string[];
}

/**
 * Extracts product details from the Amazon product page.
 * Uses Cheerio for static content and merges with dynamic data from Playwright.
 * @param $ - Cheerio instance
 * @param dynamicData - Dynamic data extracted via Playwright (optional)
 * @returns Object containing title, price, imageUrls, size, productDetails, and aboutThisItem
 */
export const extractProductDetails = (
    $: CheerioAPI,
    dynamicData?: { productDetails: Record<string, string>; aboutThisItem: string[] }
): ProductDetails => {
    const title = $(SELECTORS.TITLE).first().text().trim();
    const price = parseNumberFromSelector($, SELECTORS.PRICE);
    const imageUrls = extractImageUrls($);
    const size = extractSize($);
    
    // Use dynamic data if provided, otherwise return empty
    const productDetails = dynamicData?.productDetails || {};
    const aboutThisItem = dynamicData?.aboutThisItem || [];
    
    return {
        title,
        price,
        imageUrls,
        size,
        productDetails,
        aboutThisItem,
    };
};

/**
 * Handles the captcha blocking. Throws an error if a captcha is displayed.
 * - Crawlee automatically retries any requests that throw an error.
 * - Status code blocking (e.g. Amazon's `503`) is handled automatically by Crawlee.
 * @param $ - Cheerio instance
 * @throws Error if captcha is detected
 */
export const handleCaptchaBlocking = ($: CheerioAPI): void => {
    const isCaptchaDisplayed = $(SELECTORS.CAPTCHA).length > 0;
    if (isCaptchaDisplayed) {
        throw new Error('Captcha is displayed! Retrying...');
    }
};

