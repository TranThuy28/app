"use client";

import { useMemo, useState } from "react";
import { ImageUploader } from "@/components/ImageUploader";
import { ProductCard } from "@/components/ProductCard";
import { ResultModal } from "@/components/ResultModal";
import { deleteProduct as deleteProductApi, generateTryOn, suggestOutfits } from "@/lib/api";
import { motion } from "framer-motion";
import { ChevronLeft, ChevronRight } from "lucide-react";

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

export default function Home() {
  const [userFile, setUserFile] = useState<File | null>(null);
  const [userPreview, setUserPreview] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Minimalist office look for tomorrow's board meeting.");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [outfits, setOutfits] = useState<Product[]>([]);
  const [showWardrobe, setShowWardrobe] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);
  const [modalOpen, setModalOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [resultImage, setResultImage] = useState<string | undefined>(undefined);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const ITEMS_PER_PAGE = 10;

  const handleAnalyze = async () => {
    if (!prompt.trim()) return;
    setIsAnalyzing(true);
    try {
      console.log('Calling suggestOutfits with prompt:', prompt);
      const data = await suggestOutfits(prompt);
      console.log('Received data from backend:', data);
      // Backend /api/suggest trả về dạng { items, category, message }
      const list: Product[] = data?.items ?? data?.products ?? [];
      console.log('Extracted items:', list.length);
      setOutfits(list);
      setShowWardrobe(list.length > 0);
      setCurrentPage(0);
      if (list.length === 0) {
        alert('No products found. Please try a different prompt or check if the backend server is running.');
      }
    } catch (error: any) {
      console.error("Failed to fetch outfits", error);
      const errorMessage = error?.response?.data?.error || error?.message || 'Failed to connect to backend server. Please make sure the server is running on port 4000.';
      alert(`Error: ${errorMessage}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const totalPages = useMemo(() => Math.max(1, Math.ceil(outfits.length / ITEMS_PER_PAGE)), [outfits.length]);
  const visibleProducts = useMemo(
    () => outfits.slice(currentPage * ITEMS_PER_PAGE, currentPage * ITEMS_PER_PAGE + ITEMS_PER_PAGE),
    [outfits, currentPage]
  );

  const handleProductSelect = async (product: Product) => {
    if (!userFile) {
      alert("Please upload your photo first.");
      return;
    }
    setSelectedProduct(product);
    setModalOpen(true);
    setIsGenerating(true);
    setResultImage(undefined);
    try {
      const response = await generateTryOn(userFile, product);
      const imageUrl =
        response?.image_url ||
        response?.result_image ||
        response?.result ||
        response?.data ||
        null;
      setResultImage(imageUrl ?? undefined);
    } catch (error) {
      console.error("Failed to generate try-on", error);
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDelete = async (product: Product) => {
    if (!product.category_folder) {
      console.warn('Product missing category_folder, cannot delete.');
      return;
    }
    try {
      await deleteProductApi(product.category_folder, product.id);
      setOutfits((prev) => {
        const next = prev.filter((item) => item.id !== product.id);
        const newTotalPages = Math.max(1, Math.ceil(next.length / ITEMS_PER_PAGE));
        setCurrentPage((prevPage) =>
          prevPage >= newTotalPages ? Math.max(0, newTotalPages - 1) : prevPage
        );
        return next;
      });
    } catch (error) {
      console.error('Failed to delete product', error);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-black text-white">
      <main className="mx-auto flex min-h-screen max-w-6xl flex-col gap-16 px-6 py-12 md:px-10">
        <header className="text-center">
          <p className="text-sm uppercase tracking-[0.5em] text-purple-400">Aura Stylist</p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight text-white md:text-5xl">
            AI Stylist for the Modern Wardrobe
          </h1>
          <p className="mt-4 text-base text-white/60 md:text-lg">
            Upload your look, describe your vibe, and let the wardrobe curate personalized pieces.
          </p>
        </header>

        <section className="space-y-6 rounded-3xl border border-white/10 bg-white/5 p-8 shadow-2xl shadow-purple-500/10 backdrop-blur-3xl">
          <ImageUploader onFileChange={setUserFile} onPreviewChange={setUserPreview} />

          <div className="space-y-4">
            <label className="text-sm uppercase tracking-[0.4em] text-white/60">Prompt</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="h-32 w-full rounded-2xl border border-white/10 bg-black/40 px-4 py-3 text-white placeholder:text-white/40 focus:border-purple-500 focus:outline-none"
            />
          </div>

          <button
            disabled={isAnalyzing}
            onClick={handleAnalyze}
            className="w-full rounded-full bg-gradient-to-r from-purple-500 via-indigo-500 to-cyan-500 px-6 py-4 text-lg font-medium uppercase tracking-[0.3em] text-white shadow-lg shadow-purple-500/30 transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isAnalyzing ? "Analyzing..." : "Analyze Style"}
          </button>
        </section>

        {showWardrobe && outfits.length > 0 && (
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm uppercase tracking-[0.4em] text-white/50">Wardrobe</p>
                <h2 className="text-2xl font-semibold text-white">Curated Picks</h2>
              </div>
        </div>

            <div className="relative flex items-center">
              <button
                onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
                disabled={currentPage === 0}
                className="absolute -left-16 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-30"
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
              <motion.div
                key={currentPage}
                initial={{ opacity: 0, x: currentPage > 0 ? 50 : -50 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.3 }}
                className="grid w-full gap-6 pb-4 md:grid-cols-5"
              >
                {visibleProducts.map((product: Product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onSelect={handleProductSelect}
                    onDelete={() => handleDelete(product)}
            />
                ))}
              </motion.div>
              <button
                onClick={() => setCurrentPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={currentPage >= totalPages - 1}
                className="absolute -right-16 flex h-10 w-10 items-center justify-center rounded-full bg-white/10 text-white transition hover:bg-white/20 disabled:opacity-30"
              >
                <ChevronRight className="h-5 w-5" />
              </button>
        </div>

            <p className="text-center text-sm text-white/70">
              Page {Math.min(currentPage + 1, totalPages)} of {totalPages}
            </p>
          </section>
        )}
      </main>

      <ResultModal
        open={modalOpen}
        loading={isGenerating}
        userImage={userPreview ?? undefined}
        resultImage={resultImage}
        productTitle={selectedProduct?.title}
        productUrl={selectedProduct?.product_url}
        aboutThisItem={selectedProduct?.aboutThisItem}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
