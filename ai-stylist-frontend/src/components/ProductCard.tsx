'use client';

import { motion } from 'framer-motion';
import { X } from 'lucide-react';

type Product = {
  id: string;
  title: string;
  price: number;
  description: string;
  image_url: string;
  category_folder?: 'casual' | 'hanging' | 'office' | 'party';
};

type ProductCardProps = {
  product: Product;
  onSelect: (product: Product) => void;
  onDelete?: (id: string) => void;
};

export function ProductCard({ product, onSelect, onDelete }: ProductCardProps) {
  const imageSrc = product.image_url || '';
  return (
    <motion.div
      className="group relative h-80 w-56 overflow-hidden rounded-2xl border border-white/5 bg-white/5 shadow-xl backdrop-blur-xl"
      whileHover={{ y: -6 }}
      onClick={() => onSelect(product)}
    >
      {onDelete && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete(product.id);
          }}
          className="absolute right-2 top-2 z-10 rounded-full bg-red-500/80 p-1 text-white opacity-0 transition group-hover:opacity-100 hover:bg-red-600"
          aria-label="Delete product"
        >
          <X className="h-4 w-4" />
        </button>
      )}
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


