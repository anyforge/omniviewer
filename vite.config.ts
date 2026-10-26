import { defineConfig } from "vite";
import { fileViewerRenderers } from "@file-viewer/vite-plugin";
// @ts-expect-error type error without @types/node package
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(() => ({
  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  plugins: [
    // file-viewer：全格式支持，剔除 CAD（renderer-cad 依赖 AGPL 的 @flyfish-dev/cad-viewer）
    // 白名单 = preset-all 全部 renderer 去掉 cad（dicom/signature/design/binary 本就不在 preset-all）
    fileViewerRenderers({
      copyAssets: true,
      renderers: [
        "pdf",
        "ofd",
        "typst",
        "presentation",
        "presentation-binary",
        "presentation-openxml",
        "word",
        "spreadsheet",
        "iwork",
        "wordperfect",
        "hangul",
        "drawing",
        "model",
        "archive",
        "chm",
        "email",
        "ebook",
        "text",
        "image",
        "media",
        "mindmap",
        "geo",
        "data",
        "eda",
      ],
    }),
  ],
  optimizeDeps: {
    // highlight.js 的 es/core.js 相对引用了 CJS 的 ../lib/core.js（module.exports 无 default 导出），
    // Vite dev 原样 serve 时 default 导入失败，导致 file-viewer 代码语法高亮静默回退为纯文本。
    // 预打包后 esbuild 做 CJS→ESM 互操作，core 才有 default 导出，语法高亮才生效。
    include: ["highlight.js/lib/core"],
  },
}));
