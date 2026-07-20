/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => {
  // `--mode singlefile` emits one self-contained bundle (fonts inlined,
  // no code splitting) for the hosted single-file demo build.
  const singlefile = mode === 'singlefile'
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: false,
    },
    build: singlefile
      ? {
          outDir: 'dist-single',
          chunkSizeWarningLimit: 8192,
          assetsInlineLimit: 100_000_000,
          cssCodeSplit: false,
          rollupOptions: {
            output: { inlineDynamicImports: true },
          },
        }
      : {
          chunkSizeWarningLimit: 4096,
          rollupOptions: {
            output: {
              manualChunks: {
                tf: ['@tensorflow/tfjs', '@tensorflow-models/coco-ssd'],
                mp: ['@mediapipe/tasks-vision'],
              },
            },
          },
        },
    test: {
      environment: 'node',
      include: ['src/**/__tests__/**/*.test.ts'],
    },
  }
})
