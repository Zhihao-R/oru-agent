import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve(__dirname, 'shared'),
      },
    },
    build: {
      outDir: 'out/main',
      lib: {
        entry: resolve(__dirname, 'electron/main/index.ts'),
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      // 多 preload entry：主窗口 preload + deck 预览 webview 内的 preload
      // 都强制 CJS（Electron 41 ESM preload 加载 webUtils 时静默终止）
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'electron/preload/index.ts'),
          deckPreview: resolve(__dirname, 'electron/preload/deckPreview.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src'),
        '@shared': resolve(__dirname, 'shared'),
      },
    },
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        // 多渲染器入口：主窗 index.html + 唤起对话承载窗 overlay.html（独立第二渲染器）
        input: {
          index: resolve(__dirname, 'src/index.html'),
          overlay: resolve(__dirname, 'src/overlay.html'),
        },
      },
    },
    server: {
      port: 5173,
    },
  },
});
