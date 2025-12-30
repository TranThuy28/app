import 'dotenv/config';
import axios from 'axios';

/**
 * Test script to verify Pinkyne API Vision capabilities
 * * Usage:
 * npx ts-node scripts/test-vision-pinkyne.ts
 */

// Configuration
const PINKYNE_API_KEY = process.env.PINKYNE_API_KEY || process.env.API_KEY; // Sửa lại tên biến môi trường của bạn
const PINKYNE_BASE_URL = process.env.PINKYNE_BASE_URL || 'https://api.pinkyne.com/v1'; // Check lại base URL của bạn
const MODEL_NAME = 'gpt-4o-mini'; // Hoặc model bạn đang dùng

const testUrl = "https://m.media-amazon.com/images/I/81ThfAs7zzL.jpg";

if (!PINKYNE_API_KEY) {
    console.error('❌ Error: API Key not found in .env');
    process.exit(1);
}

// Helper function to call Pinkyne
async function callPinkyne(payload: any) {
    try {
        const response = await axios.post(
            `${PINKYNE_BASE_URL.replace(/\/+$/, '')}/chat/completions`,
            payload,
            {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${PINKYNE_API_KEY}`
                },
                timeout: 30000 
            }
        );
        return response.data;
    } catch (error: any) {
        if (error.response) {
            console.error(`❌ API Error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
        } else {
            console.error(`❌ Network Error: ${error.message}`);
        }
        return null;
    }
}

/**
 * Experiment A: Gửi Link ảnh trực tiếp (URL)
 */
async function experimentA_DirectLink() {
    console.log('\n' + '='.repeat(50));
    console.log('🔬 EXPERIMENT A: Direct URL Approach');
    console.log('='.repeat(50));
    console.log(`URL: ${testUrl}`);

    const payload = {
        model: MODEL_NAME,
        messages: [
            {
                role: "user",
                content: [
                    { type: "text", text: "Describe this clothing item in detail. What is the color and material?" },
                    { 
                        type: "image_url", 
                        image_url: { 
                            url: testUrl // Gửi thẳng URL
                        } 
                    }
                ]
            }
        ],
        max_tokens: 300
    };

    const data = await callPinkyne(payload);
    
    if (data && data.choices && data.choices[0]) {
        console.log('✅ Success! Model Response:');
        console.log(data.choices[0].message.content);
    } else {
        console.log('⚠️ Failed or Empty Response. (Pinkyne/Gemini might not support direct URLs)');
    }
}

/**
 * Experiment B: Tải ảnh -> Base64 -> Gửi (Khuyên dùng)
 */
async function experimentB_Base64() {
    console.log('\n' + '='.repeat(50));
    console.log('🔬 EXPERIMENT B: Base64 Approach (Recommended)');
    console.log('='.repeat(50));

    try {
        // 1. Tải ảnh về (giả lập server tải ảnh)
        console.log('📥 Downloading image...');
        const imgRes = await axios.get(testUrl, { 
            responseType: 'arraybuffer',
            headers: { 'User-Agent': 'Mozilla/5.0...' } // Fake UA để tránh Amazon chặn
        });
        
        // 2. Convert sang Base64
        const base64Image = Buffer.from(imgRes.data).toString('base64');
        const dataURI = `data:image/jpeg;base64,${base64Image}`;
        console.log(`📦 Converted to Base64 (${base64Image.length} chars)`);

        // 3. Gửi lên Pinkyne
        const payload = {
            model: MODEL_NAME,
            messages: [
                {
                    role: "user",
                    content: [
                        { type: "text", text: "Describe this clothing item. Is it suitable for a party?" },
                        { 
                            type: "image_url", 
                            image_url: { 
                                url: dataURI // Gửi chuỗi Data URI
                            } 
                        }
                    ]
                }
            ],
            max_tokens: 300
        };

        console.log('🚀 Sending to Pinkyne...');
        const data = await callPinkyne(payload);

        if (data && data.choices && data.choices[0]) {
            console.log('✅ Success! Model Response:');
            console.log(data.choices[0].message.content);
        } else {
            console.log('❌ Failed to get response via Base64');
        }

    } catch (error: any) {
        console.error('❌ Download failed:', error.message);
    }
}

// Chạy test
(async () => {
    await experimentA_DirectLink();
    await experimentB_Base64();
})();