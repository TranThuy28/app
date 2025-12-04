import 'dotenv/config';
import axios from 'axios';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { SimpleStylist } from './services/simple-stylist.ts';
import { VtonService } from './services/vton-service.ts';

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

const storageRoot = path.join(process.cwd(), 'storage');
const uploadsDir = path.join(storageRoot, 'uploads');
const tryOnDir = path.join(storageRoot, 'try-on');

fs.mkdirSync(uploadsDir, { recursive: true });
fs.mkdirSync(tryOnDir, { recursive: true });

app.use('/storage', express.static(storageRoot));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${Date.now()}-${file.fieldname}${ext}`);
  },
});

const upload = multer({ storage });

const stylist = new SimpleStylist();
const vtonService = new VtonService();

app.post('/api/suggest', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }
    const suggestions = await stylist.suggestOutfit(message);
    res.json(suggestions);
  } catch (error) {
    console.error('Error in /api/suggest:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions' });
  }
});

app.post('/api/try-on', upload.single('user_image'), async (req, res) => {
  try {
    const query = req.body.query;
    const productImageRelative: string | undefined = req.body.product_image_path;
    const file = req.file;

    if (!file || !query || !productImageRelative) {
      return res
        .status(400)
        .json({ error: 'user_image file, query and product_image_path are required' });
    }

    const userImagePath = file.path;

    const tryResolvePath = async (relativePath: string) => {
      if (relativePath.startsWith('http://') || relativePath.startsWith('https://')) {
        // Download the remote image to a temp file so VTON can read it
        const resp = await axios.get(relativePath, { responseType: 'arraybuffer' });
        const tempPath = path.join(uploadsDir, `product-${Date.now()}.jpg`);
        fs.writeFileSync(tempPath, resp.data);
        return tempPath;
      }

      const firstAttempt = path.isAbsolute(relativePath)
        ? relativePath
        : path.resolve(relativePath);
      if (fs.existsSync(firstAttempt)) return firstAttempt;

      const secondAttempt = path.join(storageRoot, relativePath);
      if (fs.existsSync(secondAttempt)) return secondAttempt;

      throw new Error(`Cannot find product image at ${relativePath}`);
    };

    const productImagePath = await tryResolvePath(productImageRelative);

    const outputFileName = `tryon-${Date.now()}-${path.parse(file.filename).name}.png`;
    const outputPath = path.join(tryOnDir, outputFileName);

    const prompt = `A high-quality photorealistic image of the person in the first image wearing the outfit shown in the second image. Keeping exactly features of the first image, always generate the front view of the person.
        Ensure the clothing fit and texture look realistic. Keep the person's face, hair, and pose exactly as in the first image. For dresses or pants, it is important to create the full body of the person in the photo as best as possible. IMPORTANT: keep all facial features and gestures of the person in the first photo intact. The theme of there outfit is all about: ${query}.`;

    await vtonService.generateTryOn(userImagePath, productImagePath, outputPath, prompt);

    res.json({
      success: true,
      image_url: `/storage/try-on/${outputFileName}`,
    });
  } catch (error) {
    console.error('Error in /api/try-on:', error);
    res.status(500).json({ error: 'Failed to generate try-on image' });
  }
});

app.delete('/api/products/:category/:id', (req, res) => {
  try {
    const { category, id } = req.params;
    if (!category || !id) {
      return res.status(400).json({ success: false, message: 'Category and id are required' });
    }

    const normalizedCategory = category as 'casual' | 'hanging' | 'office' | 'party';
    const success = stylist.deleteProduct(normalizedCategory, id);

    if (!success) {
      return res.status(404).json({ success: false, message: 'Product not found' });
    }

    res.json({ success: true, message: 'Product deleted' });
  } catch (error) {
    console.error('Error deleting product:', error);
    res.status(500).json({ success: false, message: 'Failed to delete product' });
  }
});

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});


