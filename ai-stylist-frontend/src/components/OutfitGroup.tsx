'use client';

import { motion } from 'framer-motion';
import { ProductCard } from './ProductCard';

type Product = {
  id: string;
  title: string;
  price: number;
  description: string;
  image_url: string;
  product_url?: string;
  aboutThisItem?: string[];
  category_folder?: 'casual' | 'hanging' | 'office' | 'party';
};

type Outfit = {
  name: string;
  reasoning: string;
  items: Product[];
};

type OutfitGroupProps = {
  outfit: Outfit;
  onProductSelect: (product: Product) => void;
  onProductDelete?: (product: Product) => void;
  onTryOn?: (productUrls: string[]) => void;
};

export function OutfitGroup({ outfit, onProductSelect, onProductDelete, onTryOn }: OutfitGroupProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4 }}
      className="space-y-6 rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl shadow-purple-500/10 backdrop-blur-3xl"
    >
      {/* Outfit Name and Reasoning */}
      <div className="space-y-4">
        <div>
          <p className="text-xs uppercase tracking-[0.4em] text-purple-400">Outfit</p>
          <h3 className="mt-2 text-2xl font-semibold text-white">{outfit.name}</h3>
        </div>
        <div>
          <p className="text-xs uppercase tracking-[0.3em] text-white/50">Reasoning</p>
          <p className="mt-2 text-base leading-relaxed text-white/80">{outfit.reasoning}</p>
        </div>
      </div>

      {/* Items Grid */}
      {outfit.items && outfit.items.length > 0 && (
        <div className="space-y-4">
          <p className="text-xs uppercase tracking-[0.3em] text-white/50">Items in this outfit</p>
          <div className="grid grid-cols-2 gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
            {outfit.items.map((product) => (
              <ProductCard
                key={product.id}
                product={product}
                onSelect={onProductSelect}
                onDelete={onProductDelete ? () => onProductDelete(product) : undefined}
              />
            ))}
          </div>
        </div>
      )}

      {/* Try This Look Button */}
      <div className="pt-4">
        <button
          onClick={() => {
            if (!onTryOn) {
              alert('Please upload your photo first to try on this outfit.');
              return;
            }
            // Collect all product image URLs
            const urls = outfit.items.map(item => item.image_url).filter(url => url);
            if (urls.length === 0) {
              alert('No product images available for this outfit.');
              return;
            }
            onTryOn(urls);
          }}
          className="w-full rounded-full bg-gradient-to-r from-purple-500 via-indigo-500 to-cyan-500 px-6 py-3 text-sm font-medium uppercase tracking-[0.2em] text-white shadow-lg shadow-purple-500/30 transition hover:opacity-90"
        >
          Try This Look
        </button>
      </div>
    </motion.div>
  );
}

