import * as dotenv from 'dotenv';
dotenv.config(); // Nạp API Key từ .env

import * as fs from 'fs';
import * as path from 'path';
import { SimpleStylist } from './services/simple-stylist';
import { VtonService } from './services/vton-service';

/**
 * CẤU HÌNH INPUT TEST Ở ĐÂY
 */
const TEST_CONFIG = {
    // 1. Câu hỏi của User (để test phân loại)
    userQuery: "Tìm cho mình set đồ đi làm công sở lịch sự",
    
    // 2. Đường dẫn ảnh User (Bạn phải để sẵn 1 ảnh ở đây)
    userImagePath: 'storage/test.png', 
    
    // 3. Đường dẫn lưu ảnh kết quả
    outputImagePath: 'storage/try-on/test-result-final.png'
};

async function runTest() {
    console.log("🚀 BẮT ĐẦU TEST TOÀN BỘ LUỒNG HỆ THỐNG...");

    // --- BƯỚC 0: KIỂM TRA MÔI TRƯỜNG ---
    if (!fs.existsSync(TEST_CONFIG.userImagePath)) {
        console.error(`❌ Lỗi: Không tìm thấy ảnh user tại '${TEST_CONFIG.userImagePath}'`);
        console.error("👉 Hãy copy một file ảnh .jpg/.png của bạn vào thư mục 'storage' và đổi tên thành 'test.png' rồi chạy lại.");
        return;
    }
    
    if (!process.env.PINKYNE_API_KEY) {
        console.error("❌ Lỗi: Chưa cấu hình PINKYNE_API_KEY trong file .env");
        return;
    }

    try {
        // --- BƯỚC 1: STYLIST (TÌM ĐỒ) ---
        console.log(`\n1️⃣  Stylist đang phân tích: "${TEST_CONFIG.userQuery}"...`);
        const stylist = new SimpleStylist();
        const outfitResult = await stylist.suggestOutfit(TEST_CONFIG.userQuery);

        if (outfitResult.items.length === 0) {
            console.error("❌ Stylist không tìm thấy món đồ nào trong kho.");
            console.error(`   (Category folder: ${outfitResult.category} đang rỗng?)`);
            return;
        }

        // Lấy sản phẩm đầu tiên
        const selectedProduct = outfitResult.items[0];
        console.log(`✅ Đã chọn sản phẩm: ${selectedProduct.title}`);
        console.log(`   - ID: ${selectedProduct.id}`);
        console.log(`   - Category: ${outfitResult.category}`);
        console.log(`   - Ảnh gốc SP: ${selectedProduct.image_url}`);

        // Xử lý đường dẫn ảnh sản phẩm (chuyển sang đường dẫn tuyệt đối để đảm bảo fs đọc được)
        // product.image_url thường là 'storage/products/...' hoặc 'products/...' tùy lúc lưu
        // Ta cần đảm bảo nó trỏ đúng file
        let productAbsPath = path.resolve(selectedProduct.image_url);
        // Fallback: nếu đường dẫn trong json thiếu chữ 'storage' ở đầu
        if (!fs.existsSync(productAbsPath)) {
             productAbsPath = path.resolve('storage', selectedProduct.image_url);
        }

        if (!fs.existsSync(productAbsPath)) {
            console.error(`❌ Lỗi: Không tìm thấy file ảnh sản phẩm tại: ${productAbsPath}`);
            return;
        }

        // --- BƯỚC 2: CHUẨN BỊ PROMPT ---
        console.log("\n2️⃣  Đang tạo Prompt cho AI...");
        const productDesc = selectedProduct.description || "Fashionable outfit";
        const materials = selectedProduct.material ? selectedProduct.material.join(", ") : "fabric";
        
        // Prompt ghép mặt người vào đồ
        const prompt = `A high-quality photorealistic image of the person in the first image wearing the outfit shown in the second image. 
        Outfit Description: ${selectedProduct.title}. ${productDesc}. 
        Material: ${materials}. 
        Ensure the clothing fit and texture look realistic. Keep the person's face, hair, and pose exactly as in the first image.`;

        console.log(`   Prompt length: ${prompt.length} chars`);

        // --- BƯỚC 3: VTON SERVICE (GEN ẢNH) ---
        console.log("\n3️⃣  Đang gọi API Gen ảnh (Có thể mất 10-30s)...");
        const vtonService = new VtonService();
        
        // Tạo thư mục output nếu chưa có
        const outDir = path.dirname(TEST_CONFIG.outputImagePath);
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

        // Gọi dịch vụ VTON với 2 ảnh: User + Product
        await vtonService.generateTryOn(
            path.resolve(TEST_CONFIG.userImagePath),  // Ảnh User
            productAbsPath,                           // Ảnh Sản phẩm đã được resolve ở trên
            path.resolve(TEST_CONFIG.outputImagePath),// Ảnh Kết quả
            prompt                                    // Prompt kèm mô tả sản phẩm
        );

        console.log("\n------------------------------------------------");
        console.log("🎉 THÀNH CÔNG! ĐÃ CÓ ẢNH KẾT QUẢ.");
        console.log(`📂 File ảnh nằm tại: ${path.resolve(TEST_CONFIG.outputImagePath)}`);
        console.log("------------------------------------------------\n");

    } catch (error) {
        console.error("\n❌ CÓ LỖI XẢY RA TRONG QUÁ TRÌNH TEST:");
        console.error(error);
    }
}

// Chạy hàm test
runTest();