'use client';

import { AnimatePresence, motion } from 'framer-motion';

type ResultModalProps = {
  open: boolean;
  loading: boolean;
  resultImage?: string;
  userImage?: string;
  onClose: () => void;
};

export function ResultModal({ open, loading, resultImage, userImage, onClose }: ResultModalProps) {
  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 backdrop-blur-xl"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="relative w-full max-w-5xl rounded-3xl border border-white/10 bg-gradient-to-br from-slate-900/80 to-black/80 p-8 text-white shadow-2xl"
            initial={{ scale: 0.9, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.9, opacity: 0 }}
          >
            {loading ? (
              <div className="flex items-center justify-center py-32">
                <motion.div
                  className="h-24 w-24 rounded-full border-4 border-white/20 border-t-4 border-t-purple-400"
                  animate={{ rotate: 360 }}
                  transition={{ repeat: Infinity, duration: 1, ease: 'linear' }}
                />
                <p className="ml-6 text-xl text-white/70">Synthesizing look…</p>
              </div>
            ) : (
              <div>
                <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
                  <div className="space-y-3">
                    <p className="text-sm uppercase tracking-widest text-white/50">Original</p>
                    {userImage ? (
                      <img src={userImage} alt="User Original" className="rounded-2xl object-cover" />
                    ) : (
                      <div className="flex h-64 items-center justify-center rounded-2xl bg-white/5 text-white/40">
                        No image
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    <p className="text-sm uppercase tracking-widest text-white/50">AI Try-On</p>
                    {resultImage ? (
                      <img src={resultImage} alt="Result" className="rounded-2xl object-cover" />
                    ) : (
                      <div className="flex h-64 items-center justify-center rounded-2xl bg-white/5 text-white/40">
                        No result
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-8 flex flex-wrap gap-4">
                  <button
                    onClick={onClose}
                    className="rounded-full border border-white/20 px-6 py-2 text-sm uppercase tracking-widest text-white transition hover:border-white"
                  >
                    Try Another Item
                  </button>
                  {resultImage && (
                    <a
                      href={resultImage}
                      download="ai-stylist-result.png"
                      className="rounded-full bg-gradient-to-r from-purple-500 to-indigo-500 px-6 py-2 text-sm uppercase tracking-widest text-white shadow-lg shadow-purple-500/30 transition hover:opacity-90"
                    >
                      Download
                    </a>
                  )}
                </div>
              </div>
            )}

            <button
              onClick={onClose}
              className="absolute right-6 top-6 rounded-full border border-white/10 bg-white/10 px-3 py-1 text-xs uppercase tracking-widest text-white/70 transition hover:bg-white/20"
            >
              Close
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}



