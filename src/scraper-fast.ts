import axios from 'axios';
import * as cheerio from 'cheerio';
import type { ProductDetails } from './scraper.ts';

// Cheerio API type
type CheerioAPI = ReturnType<typeof cheerio.load>;

/**
 * Converts Playwright cookie array to Cookie header string
 * @param cookies - Array of cookie objects from Playwright
 * @returns Cookie header string (e.g., "name1=value1; name2=value2")
 */
const cookiesToHeaderString = (cookies: any[]): string => {
    return cookies
        .map((cookie) => `${cookie.name}=${cookie.value}`)
        .join('; ');
};

/**
 * Cleans Amazon image URL by removing resizing parameters to get high-resolution version.
 * @param url - The Amazon image URL with resizing parameters
 * @returns Cleaned URL without resizing parameters
 */
const cleanImageUrl = (url: string): string => {
    return url.replace(/\._AC_.*?_/, '');
};

/**
 * Extracts high-resolution image URLs from data-a-dynamic-image attribute
 * @param $ - Cheerio instance
 * @returns Array of unique high-resolution image URL strings
 */
const extractImageUrls = ($: CheerioAPI): string[] => {
    const imageUrlSet = new Set<string>();

    // Try #landingImage first
    const landingImage = $('#landingImage');
    if (landingImage.length > 0) {
        const dataDynamic = landingImage.attr('data-a-dynamic-image');
        if (dataDynamic) {
            try {
                const dynamicImages = JSON.parse(dataDynamic);
                Object.keys(dynamicImages).forEach((url) => {
                    const cleanedUrl = cleanImageUrl(url);
                    imageUrlSet.add(cleanedUrl);
                });
            } catch (e) {
                // Fallback to src attribute
                const src = landingImage.attr('src');
                if (src) {
                    imageUrlSet.add(cleanImageUrl(src));
                }
            }
        } else {
            const src = landingImage.attr('src');
            if (src) {
                imageUrlSet.add(cleanImageUrl(src));
            }
        }
    }

    // Try #imgBlkFront as fallback
    const imgBlkFront = $('#imgBlkFront');
    if (imgBlkFront.length > 0) {
        const dataDynamic = imgBlkFront.attr('data-a-dynamic-image');
        if (dataDynamic) {
            try {
                const dynamicImages = JSON.parse(dataDynamic);
                Object.keys(dynamicImages).forEach((url) => {
                    const cleanedUrl = cleanImageUrl(url);
                    imageUrlSet.add(cleanedUrl);
                });
            } catch (e) {
                const src = imgBlkFront.attr('src');
                if (src) {
                    imageUrlSet.add(cleanImageUrl(src));
                }
            }
        }
    }

    // Fallback: try altImages
    $('#altImages .item img').each((_, element) => {
        const src = $(element).attr('src');
        if (src) {
            imageUrlSet.add(cleanImageUrl(src));
        }
    });

    return Array.from(imageUrlSet);
};

/**
 * Extracts productDetails by searching for key-value patterns in tables and lists
 * @param $ - Cheerio instance
 * @returns Record of key-value pairs
 */
const extractProductDetails = ($: CheerioAPI): Record<string, string> => {
    const details: Record<string, string> = {};

    // Search in tables (tr elements)
    $('table tr').each((_, row) => {
        const cells = $(row).find('td, th');
        if (cells.length >= 2) {
            const key = $(cells[0]).text().trim().replace(/:/g, '');
            const value = $(cells[1]).text().trim();
            if (key && value && key.length < 100) {
                // Common patterns: "Fabric type", "Origin", "Material", etc.
                const lowerKey = key.toLowerCase();
                if (
                    lowerKey.includes('fabric') ||
                    lowerKey.includes('material') ||
                    lowerKey.includes('origin') ||
                    lowerKey.includes('care') ||
                    lowerKey.includes('fit') ||
                    lowerKey.includes('style') ||
                    lowerKey.includes('color') ||
                    lowerKey.includes('pattern') ||
                    lowerKey.includes('closure') ||
                    lowerKey.includes('sleeve') ||
                    lowerKey.includes('length')
                ) {
                    details[key] = value;
                }
            }
        }
    });

    // Search in ul li elements (common in product specifications)
    $('ul li').each((_, li) => {
        const text = $(li).text().trim();
        // Pattern: "Key: Value" or "Key - Value"
        const colonMatch = text.match(/^([^:]+):\s*(.+)$/);
        const dashMatch = text.match(/^([^-]+)-\s*(.+)$/);

        if (colonMatch) {
            const key = colonMatch[1].trim();
            const value = colonMatch[2].trim();
            const lowerKey = key.toLowerCase();
            if (
                (lowerKey.includes('fabric') ||
                    lowerKey.includes('material') ||
                    lowerKey.includes('origin') ||
                    lowerKey.includes('care') ||
                    lowerKey.includes('fit') ||
                    lowerKey.includes('style') ||
                    lowerKey.includes('color') ||
                    lowerKey.includes('pattern')) &&
                value.length > 0 &&
                key.length < 100
            ) {
                details[key] = value;
            }
        } else if (dashMatch) {
            const key = dashMatch[1].trim();
            const value = dashMatch[2].trim();
            const lowerKey = key.toLowerCase();
            if (
                (lowerKey.includes('fabric') ||
                    lowerKey.includes('material') ||
                    lowerKey.includes('origin') ||
                    lowerKey.includes('care') ||
                    lowerKey.includes('fit') ||
                    lowerKey.includes('style') ||
                    lowerKey.includes('color') ||
                    lowerKey.includes('pattern')) &&
                value.length > 0 &&
                key.length < 100
            ) {
                details[key] = value;
            }
        }
    });

    return details;
};

/**
 * Extracts "About this item" bullets
 * @param $ - Cheerio instance
 * @returns Array of bullet point strings
 */
const extractAboutThisItem = ($: CheerioAPI): string[] => {
    const bullets: string[] = [];

    // Strategy 1: Find element containing "About this item" text
    $('h1, h2, h3, h4, h5, strong, span, div').each((_, element) => {
        const text = $(element).text().trim().toLowerCase();
        if (text.includes('about this item') || text === 'about this item') {
            // Look for adjacent ul
            const nextUl = $(element).next('ul');
            if (nextUl.length > 0) {
                nextUl.find('li').each((_, li) => {
                    const bulletText = $(li).text().trim();
                    if (bulletText) {
                        bullets.push(bulletText);
                    }
                });
                return false; // Break the loop
            }

            // Look for parent's next sibling ul
            const parentNextUl = $(element).parent().next('ul');
            if (parentNextUl.length > 0) {
                parentNextUl.find('li').each((_, li) => {
                    const bulletText = $(li).text().trim();
                    if (bulletText) {
                        bullets.push(bulletText);
                    }
                });
                return false;
            }
        }
    });

    // Strategy 2: Direct search for #feature-bullets
    if (bullets.length === 0) {
        $('#feature-bullets ul li').each((_, li) => {
            const bulletText = $(li).text().trim();
            if (bulletText) {
                bullets.push(bulletText);
            }
        });
    }

    // Strategy 3: Search for common patterns
    if (bullets.length === 0) {
        $('ul[data-feature-name="featurebullets"] li, .a-unordered-list.a-vertical.a-spacing-mini li').each((_, li) => {
            const bulletText = $(li).text().trim();
            if (bulletText && bulletText.length > 10) {
                bullets.push(bulletText);
            }
        });
    }

    return bullets;
};

/**
 * Extracts all available sizes from buttons, dropdowns, or twister (new layout)
 */
const extractAllSizes = ($: CheerioAPI): string[] => {
    const sizesSet = new Set<string>();

    // Strategy A: Standard buttons under #variation_size_name
    $('#variation_size_name li').each((_, li) => {
        const text = $(li).text().replace(/\s+/g, ' ').trim();
        if (text && !/select/i.test(text)) {
            sizesSet.add(text);
        }
    });

    // Strategy B: Dropdown options
    if (sizesSet.size === 0) {
        $('#native_dropdown_selected_size_name option').each((_, option) => {
            const text = $(option).text().replace(/\s+/g, ' ').trim();
            if (text && !/select/i.test(text)) {
                sizesSet.add(text);
            }
        });
    }

    // Strategy C: Twister buttons (new layout)
    if (sizesSet.size === 0) {
        $('.a-button-toggle .a-button-text').each((_, el) => {
            const text = $(el).text().replace(/\s+/g, ' ').trim();
            if (text && !/select/i.test(text)) {
                sizesSet.add(text);
            }
        });
    }

    return Array.from(sizesSet);
};

/**
 * Extracts all available colors from swatches or twister (new layout)
 */
const extractAllColors = ($: CheerioAPI): string[] => {
    const colorsSet = new Set<string>();

    // Strategy A: Standard swatches (old layout)
    $('#variation_color_name li img').each((_, el) => {
        const alt = $(el).attr('alt');
        if (alt && alt.trim()) {
            colorsSet.add(alt.trim());
        }
    });

    // Fallback: text inside #variation_color_name li
    if (colorsSet.size === 0) {
        $('#variation_color_name li').each((_, li) => {
            const text = $(li).text().replace(/\s+/g, ' ').trim();
            if (text && !/select/i.test(text)) {
                colorsSet.add(text);
            }
        });
    }

    // Strategy B: Twister container images (new layout)
    if (colorsSet.size === 0) {
        $('#twister-plus-inline-twister-card img').each((_, el) => {
            const alt = $(el).attr('alt');
            if (alt && alt.trim()) {
                colorsSet.add(alt.trim());
            }
        });
    }

    return Array.from(colorsSet);
};

/**
 * Parses a raw string and extracts a numeric value.
 * Removes currency symbols ($, ₫) and commas before parsing.
 * @param rawString - The raw string containing a number
 * @returns The parsed number value
 */
const parseNumberValue = (rawString: string): number => {
    // Remove currency symbols, commas, and other non-numeric characters except decimal point
    const cleaned = rawString.replace(/[$₫,\s]/g, '').replace(/[^\d.]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
};

/**
 * Normalizes any detected price to USD.
 * - If the numeric value is > 5000, assume VND and convert using ~25,450 VND/USD.
 * - Otherwise treat as USD already.
 */
const normalizePriceToUSD = (rawPrice: string | number): number => {
    const numeric =
        typeof rawPrice === 'number' ? rawPrice : parseNumberValue(rawPrice);

    if (!isFinite(numeric) || numeric <= 0) {
        return 0;
    }

    if (numeric > 5000) {
        const usd = parseFloat((numeric / 25450).toFixed(2));
        console.warn(`💱 Detected VND price (${rawPrice}), converted to ~$${usd}`);
        return usd;
    }

    return parseFloat(numeric.toFixed(2));
};

/**
 * Robust price extraction with multiple fallback strategies
 * @param $ - Cheerio instance
 * @param url - Product URL (for logging)
 * @returns Extracted price as number, or 0 if not found
 */
const extractPrice = ($: CheerioAPI, url: string): number => {
    let price = 0;

    // Strategy A: Extract whole + fraction (most common format)
    const priceContainer = $('.a-price').first();
    if (priceContainer.length > 0) {
        const wholePart = priceContainer.find('.a-price-whole').first().text().trim();
        const fractionPart = priceContainer.find('.a-price-fraction').first().text().trim();

        if (wholePart || fractionPart) {
            // Combine whole and fraction (e.g., "56" + "99" = "56.99")
            const combinedPrice = wholePart && fractionPart 
                ? `${wholePart}.${fractionPart}`
                : wholePart || fractionPart;
            
            price = parseNumberValue(combinedPrice);
            if (price > 0) {
                return price;
            }
        }
    }

    // Strategy B: Extract from .a-offscreen (fallback)
    const offscreenPrice = $('.a-price .a-offscreen').first();
    if (offscreenPrice.length > 0) {
        const priceText = offscreenPrice.text().trim();
        if (priceText) {
            price = parseNumberValue(priceText);
            if (price > 0) {
                return price;
            }
        }
    }

    // Strategy C: Try .a-color-price (alternative format for deal prices)
    const colorPrice = $('.a-color-price').first();
    if (colorPrice.length > 0) {
        const priceText = colorPrice.text().trim();
        if (priceText) {
            price = parseNumberValue(priceText);
            if (price > 0) {
                return price;
            }
        }
    }

    // Strategy D: Try any element with class containing "price" and visible text
    const anyPrice = $('[class*="price"]:not(.a-price-symbol):not(.a-price-whole):not(.a-price-fraction)').first();
    if (anyPrice.length > 0) {
        const priceText = anyPrice.text().trim();
        // Check if it looks like a price (contains $ or numbers)
        if (priceText && (priceText.includes('$') || /[\d.]+/.test(priceText))) {
            price = parseNumberValue(priceText);
            if (price > 0) {
                return price;
            }
        }
    }

    // If all strategies fail, log warning and return 0
    if (price === 0) {
        console.warn(`⚠️  Could not extract price for ${url}`);
    }

    return price;
};

/**
 * Fast product scraping using Axios + Cheerio (no browser overhead)
 * @param url - Amazon product URL
 * @param cookies - Array of cookies from Playwright (optional)
 * @returns ProductDetails or null if scraping fails
 */
export const scrapeProductFast = async (
    url: string,
    cookies: any[] = []
): Promise<ProductDetails | null> => {
    try {
        // Convert cookies to header string
        const cookieHeader = cookies.length > 0 ? cookiesToHeaderString(cookies) : '';

        // Make HTTP request with cookies and browser-like headers
        const response = await axios.get(url, {
            headers: {
                'User-Agent':
                    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                Connection: 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                ...(cookieHeader ? { Cookie: cookieHeader } : {}),
            },
            timeout: 10000, // 10 second timeout
            maxRedirects: 5,
        });

        // Load HTML with Cheerio
        const $ = cheerio.load(response.data);

        // Check for captcha or error pages
        if ($('[action="/errors/validateCaptcha"]').length > 0) {
            console.warn(`Captcha detected for ${url}`);
            return null;
        }

        if ($('title').text().toLowerCase().includes('sorry')) {
            console.warn(`Error page detected for ${url}`);
            return null;
        }

        // Extract title
        const title = $('#productTitle').text().trim();
        if (!title) {
            console.warn(`No title found for ${url}`);
            return null;
        }

        // Extract price (using robust multi-strategy extraction)
        const price = normalizePriceToUSD(extractPrice($, url));

        // Extract images
        const imageUrls = extractImageUrls($);

        // Extract productDetails
        const productDetails = extractProductDetails($);

        // Extract aboutThisItem
        const aboutThisItem = extractAboutThisItem($);

        // Extract sizes and colors
        const sizes = extractAllSizes($);
        const colors = extractAllColors($);

        // Keep backward-compatible single selected size if available
        const selectedSizeElement = $('#inline-twister-expanded-dimension-text-size_name, #variation_size_name .selection').first();
        const size = selectedSizeElement.length > 0 ? selectedSizeElement.text().trim() : sizes[0];

        return {
            title,
            price,
            imageUrls,
            size,
            sizes,
            colors,
            productDetails,
            aboutThisItem,
        };
    } catch (error) {
        if (axios.isAxiosError(error)) {
            console.error(`Axios error scraping ${url}:`, error.message);
        } else {
            console.error(`Error scraping ${url}:`, error instanceof Error ? error.message : String(error));
        }
        return null;
    }
};

