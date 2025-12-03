"use client";

import { useState } from "react";
import { ImageUploader } from "@/components/ImageUploader";
import { ProductCard } from "@/components/ProductCard";
import { ResultModal } from "@/components/ResultModal";
import { generateTryOn, suggestOutfits } from "@/lib/api";

type Product = {
  id: string;
  title: string;
  price: number;
  description: string;
  image_url: string;
  product_url?: string;
  aboutThisItem?: string[];
};

export default function Home() {
  const [userFile, setUserFile] = useState<File | null>(null);
  const [userPreview, setUserPreview] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Minimalist office look for tomorrow's board meeting.");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [outfits, setOutfits] = useState<Product[]>([]);
  const [showWardrobe, setShowWardrobe] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const [modalOpen, setModalOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [resultImage, setResultImage] = useState<string | undefined>(undefined);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);
  const pageSize = 6;

  const handleAnalyze = async () => {
    if (!prompt.trim()) return;
    setIsAnalyzing(true);
    try {
      const data = await suggestOutfits(prompt);
      // Backend /api/suggest trả về dạng { items, category, message }
      const list: Product[] = data?.items ?? data?.products ?? [];
      setOutfits(list);
      setShowWardrobe(list.length > 0);
      setCurrentPage(1);
    } catch (error) {
      console.error("Failed to fetch outfits", error);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const totalPages = Math.ceil(outfits.length / pageSize) || 1;
  const paginatedOutfits = outfits.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize
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

            <div className="grid gap-6 pb-4 md:grid-cols-3">
              {paginatedOutfits.map((product: Product) => (
                <ProductCard key={product.id} product={product} onSelect={handleProductSelect} />
              ))}
            </div>

            {totalPages > 1 && (
              <div className="flex justify-center gap-2 pt-2">
                {Array.from({ length: totalPages }, (_, idx) => {
                  const page = idx + 1;
                  const isActive = page === currentPage;
                  return (
                    <button
                      key={page}
                      onClick={() => setCurrentPage(page)}
                      className={`h-9 w-9 rounded-full text-sm font-medium ${
                        isActive
                          ? 'bg-white text-black'
                          : 'bg-white/10 text-white/70 hover:bg-white/20'
                      }`}
                    >
                      {page}
                    </button>
                  );
                })}
              </div>
            )}
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
