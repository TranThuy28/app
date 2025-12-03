import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { log } from 'crawlee';

/**
 * Downloads an image from a URL and saves it locally.
 * @param url - The image URL to download
 * @param targetFolder - The target folder path (relative to storage, e.g., "products/category/id")
 * @param index - The image index (for filename)
 * @returns The relative path to the saved image, or null if download failed
 */
export const downloadImage = async (
    url: string,
    targetFolder: string,
    index: number
): Promise<string | null> => {
    try {
        // Create the directory path
        const imageDir = path.join('storage', targetFolder);
        
        // Create directories if they don't exist
        if (!fs.existsSync(imageDir)) {
            fs.mkdirSync(imageDir, { recursive: true });
        }
        
        // Download the image
        const response = await axios.get(url, {
            responseType: 'arraybuffer',
            timeout: 10000, // 10 second timeout
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            },
        });
        
        // Determine file extension from URL or content type
        let extension = 'jpg';
        const contentType = response.headers['content-type'];
        if (contentType) {
            if (contentType.includes('png')) extension = 'png';
            else if (contentType.includes('gif')) extension = 'gif';
            else if (contentType.includes('webp')) extension = 'webp';
        } else {
            // Try to get extension from URL
            const urlMatch = url.match(/\.(jpg|jpeg|png|gif|webp)/i);
            if (urlMatch) {
                extension = urlMatch[1].toLowerCase();
                if (extension === 'jpeg') extension = 'jpg';
            }
        }
        
        // Save the image
        const filename = `${index}.${extension}`;
        const filePath = path.join(imageDir, filename);
        fs.writeFileSync(filePath, response.data);
        
        // Return relative path (e.g., "products/category/id/1.jpg")
        const relativePath = path.join(targetFolder, filename).replace(/\\/g, '/');
        
        log.info(`Downloaded image ${index}`, { url, path: relativePath });
        
        return relativePath;
    } catch (error) {
        log.error(`Failed to download image ${index}`, {
            url,
            targetFolder,
            error: error instanceof Error ? error.message : String(error),
        });
        return null;
    }
};

