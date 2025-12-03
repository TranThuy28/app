import type { PlaywrightCrawlingContext } from 'crawlee';

// Use the Cheerio type from PlaywrightCrawlingContext's parseWithCheerio
type CheerioAPI = Awaited<ReturnType<PlaywrightCrawlingContext['parseWithCheerio']>>;

/**
 * Parses a raw string and extracts a numeric value.
 * Removes all non-numeric characters except the decimal point.
 * @param rawString - The raw string containing a number
 * @returns The parsed number value
 */
export const parseNumberValue = (rawString: string): number => {
    // Remove all non-numeric characters except decimal point
    const cleaned = rawString.replace(/[^\d.]/g, '');
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
};

/**
 * Extracts text from a CSS selector and parses it as a number.
 * @param $ - Cheerio instance
 * @param selector - CSS selector to find the element
 * @returns The parsed number value, or 0 if not found
 */
export const parseNumberFromSelector = ($: CheerioAPI, selector: string): number => {
    const text = $(selector).first().text().trim();
    return parseNumberValue(text);
};

