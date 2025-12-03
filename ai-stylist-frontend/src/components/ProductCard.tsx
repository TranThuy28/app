'use client';

import { motion } from 'framer-motion';

type Product = {
  id: string;
  title: string;
  price: number;
  description: string;
  image_url: string;
};

type ProductCardProps = {
  product: Product;
  onSelect: (product: Product) => void;
};

export function ProductCard({ product, onSelect }: ProductCardProps) {
  // Ảnh sản phẩm đang được backend Express (port 4000) serve dưới path /storage/...
  const baseUrl = 'http://localhost:4000/';
  const rawImage = product.image_url ?? '';
  const imageSrc =
    rawImage.startsWith('http://') || rawImage.startsWith('https://')
      ? rawImage
      : `${baseUrl}${rawImage.replace(/^\//, '')}`;

  return (
    <motion.div
      className="group relative h-80 w-56 overflow-hidden rounded-2xl border border-white/5 bg-white/5 shadow-xl backdrop-blur-xl"
      whileHover={{ y: -6 }}
      onClick={() => onSelect(product)}
    >
      <img src={imageSrc} alt={product.title} className="h-full w-full object-cover" />
      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent opacity-0 transition group-hover:opacity-100" />
      <div className="absolute inset-0 flex flex-col justify-end p-4 text-white opacity-0 transition group-hover:opacity-100">
        <h3 className="truncate text-lg font-semibold">{product.title}</h3>
        <p className="text-sm text-white/70">${product.price?.toFixed(2) ?? '—'}</p>
        <p className="mt-2 line-clamp-2 text-xs text-white/60">{product.description}</p>
      </div>
    </motion.div>
  );
}


