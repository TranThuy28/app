"use client";

import { useState } from "react";
import { ImageUploader } from "@/components/ImageUploader";
import { OutfitGroup } from "@/components/OutfitGroup";
import { ResultModal } from "@/components/ResultModal";
import { deleteProduct as deleteProductApi, generateTryOn, generateOutfitTryOn, suggestOutfits } from "@/lib/api";

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

export default function Home() {
  const [userFile, setUserFile] = useState<File | null>(null);
  const [userPreview, setUserPreview] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("Minimalist office look for tomorrow's board meeting.");
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [outfits, setOutfits] = useState<Outfit[]>([]);
  const [showWardrobe, setShowWardrobe] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [resultImage, setResultImage] = useState<string | undefined>(undefined);
  const [resultType, setResultType] = useState<'vton' | 'composite' | undefined>(undefined);
  const [resultWarning, setResultWarning] = useState<string | undefined>(undefined);
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null);

  const handleAnalyze = async () => {
    if (!prompt.trim()) return;
    setOutfits([]); // clear old data immediately
    setShowWardrobe(false);
    setIsAnalyzing(true);
    try {
      console.log('Calling suggestOutfits with prompt:', prompt);
      const data = await suggestOutfits(prompt);
      console.log('Received data from backend:', data);
      // Backend now returns { outfits: [...] }
      const outfitsList: Outfit[] = data?.outfits ?? [];
      console.log('Extracted outfits:', outfitsList.length);
      setOutfits(outfitsList);
      setShowWardrobe(outfitsList.length > 0);
      if (outfitsList.length === 0) {
        alert('No outfits found. Please try a different prompt or check if the backend server is running.');
      }
    } catch (error: any) {
      console.error("Failed to fetch outfits", error);
      const errorMessage = error?.response?.data?.error || error?.message || 'Failed to connect to backend server. Please make sure the server is running on port 4000.';
      alert(`Error: ${errorMessage}`);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleProductSelect = async (product: Product) => {
    if (!userFile) {
      alert("Please upload your photo first.");
      return;
    }
    setSelectedProduct(product);
    setModalOpen(true);
    setIsGenerating(true);
    setResultImage(undefined);
    setResultType(undefined);
    setResultWarning(undefined);
    try {
      const response = await generateTryOn(userFile, product);
      const imageUrl =
        response?.image_url ||
        response?.result_image ||
        response?.result ||
        response?.data ||
        null;
      setResultImage(imageUrl ?? undefined);
      setResultType(response?.type ?? 'vton');
      setResultWarning(response?.warning);
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
      // Remove the product from all outfits
      setOutfits((prev) => {
        return prev.map((outfit) => ({
          ...outfit,
          items: outfit.items.filter((item) => item.id !== product.id),
        })).filter((outfit) => outfit.items.length > 0); // Remove outfits with no items
      });
    } catch (error) {
      console.error('Failed to delete product', error);
    }
  };

  const handleOutfitTryOn = async (productUrls: string[]) => {
    if (!userFile) {
      alert("Please upload your photo first.");
      return;
    }

    // Convert user file to base64
    const reader = new FileReader();
    reader.onloadend = async () => {
      const userImageBase64 = reader.result as string;
      
      setSelectedProduct(null); // Clear single product selection
      setModalOpen(true);
      setIsGenerating(true);
      setResultImage(undefined);
      setResultType(undefined);
      setResultWarning(undefined);

      try {
        const response = await generateOutfitTryOn(userImageBase64, productUrls);
        const imageUrl =
          response?.image_url ||
          response?.result_image ||
          response?.result ||
          response?.data ||
          null;
        setResultImage(imageUrl ?? undefined);
        setResultType(response?.type ?? 'vton');
        setResultWarning(response?.warning);
        if (response?.success === false) {
          alert(response?.error || 'Failed to generate outfit try-on. Please try again.');
        } else if (!imageUrl) {
          alert('No image returned. Please try again.');
        }
      } catch (error) {
        console.error("Failed to generate outfit try-on", error);
        alert("Failed to generate outfit try-on. Please try again.");
      } finally {
        setIsGenerating(false);
      }
    };

    reader.onerror = () => {
      alert("Failed to read user image. Please try again.");
      setIsGenerating(false);
    };

    reader.readAsDataURL(userFile);
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

        {!isAnalyzing && showWardrobe && outfits.length > 0 && (
          <section className="space-y-8">
            <div>
              <p className="text-sm uppercase tracking-[0.4em] text-white/50">Wardrobe</p>
              <h2 className="mt-2 text-2xl font-semibold text-white">Complete Outfits</h2>
            </div>

            <div className="space-y-8">
              {outfits.map((outfit, index) => (
                <OutfitGroup
                  key={index}
                  outfit={outfit}
                  onProductSelect={handleProductSelect}
                  onProductDelete={handleDelete}
                  onTryOn={handleOutfitTryOn}
                />
              ))}
            </div>
          </section>
        )}
      </main>

      <ResultModal
        open={modalOpen}
        loading={isGenerating}
        userImage={userPreview ?? undefined}
        resultImage={resultImage}
        resultType={resultType}
        resultWarning={resultWarning}
        productTitle={selectedProduct?.title}
        productUrl={selectedProduct?.product_url}
        aboutThisItem={selectedProduct?.aboutThisItem}
        onClose={() => setModalOpen(false)}
      />
    </div>
  );
}
