import * as fs from 'fs';
import * as path from 'path';
import { log } from 'crawlee';

/**
 * Cookie Manager for rotating between multiple cookie profiles
 */
export class CookieManager {
    private cookiesPool: any[][] = [];

    /**
     * Loads all cookie JSON files from a directory
     * @param directory - Path to the cookies directory (e.g., 'cookies')
     * @returns Number of cookie profiles loaded
     */
    loadAllCookies(directory: string): number {
        this.cookiesPool = [];

        const cookiesDir = path.resolve(directory);
        if (!fs.existsSync(cookiesDir)) {
            log.warning(`Cookies directory not found: ${cookiesDir}`);
            return 0;
        }

        // Read all .json files in the directory
        const files = fs.readdirSync(cookiesDir).filter((file) => file.endsWith('.json'));

        for (const file of files) {
            try {
                const filePath = path.join(cookiesDir, file);
                const fileContent = fs.readFileSync(filePath, 'utf8');
                const cookies = JSON.parse(fileContent);

                if (Array.isArray(cookies) && cookies.length > 0) {
                    this.cookiesPool.push(cookies);
                    log.info(`Loaded cookie profile from: ${file} (${cookies.length} cookies)`);
                } else {
                    log.warning(`Invalid cookie format in ${file}: expected non-empty array`);
                }
            } catch (error) {
                log.warning(`Failed to load cookies from ${file}`, {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }

        log.info(`✅ Loaded ${this.cookiesPool.length} cookie profiles.`);
        return this.cookiesPool.length;
    }

    /**
     * Gets a random cookie array from the pool
     * @returns Random cookie array
     * @throws Error if pool is empty
     */
    getRandomCookie(): any[] {
        if (this.cookiesPool.length === 0) {
            throw new Error('Cookie pool is empty! Please load cookies first using loadAllCookies().');
        }

        const randomIndex = Math.floor(Math.random() * this.cookiesPool.length);
        return this.cookiesPool[randomIndex];
    }

    /**
     * Gets the number of cookie profiles in the pool
     * @returns Number of cookie profiles
     */
    getPoolSize(): number {
        return this.cookiesPool.length;
    }

    /**
     * Converts cookie array to Playwright-compatible format
     * @param cookies - Raw cookie array
     * @returns Playwright-compatible cookie array
     */
    static toPlaywrightCookies(cookies: any[]): any[] {
        return cookies.map((cookie: any) => {
            const mappedCookie: any = {
                name: cookie.name,
                value: cookie.value,
                domain: cookie.domain || '.amazon.com',
                path: cookie.path || '/',
                secure: cookie.secure,
                httpOnly: cookie.httpOnly,
            };

            // Handle sameSite
            if (cookie.sameSite === 'no_restriction') {
                mappedCookie.sameSite = 'None';
            } else if (cookie.sameSite === 'Strict' || cookie.sameSite === 'Lax') {
                mappedCookie.sameSite = cookie.sameSite;
            }

            // Handle expiration
            if (cookie.expirationDate) {
                mappedCookie.expires = cookie.expirationDate;
            }

            return mappedCookie;
        });
    }
}




