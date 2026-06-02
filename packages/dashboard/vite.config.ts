import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import dts from "vite-plugin-dts";
import { resolve } from "node:path";

export default defineConfig({
  plugins: [react(), dts({ rollupTypes: true })],
  build: {
    lib: {
      entry: resolve(__dirname, "src/index.ts"),
      name: "Strk20Dashboard",
      formats: ["es"],
      fileName: () => "index.js",
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"],
      output: {
        globals: {
          react: "React",
          "react-dom": "ReactDOM",
        },
        assetFileNames: (info) =>
          info.name === "style.css" ? "style.css" : "assets/[name][extname]",
      },
    },
    sourcemap: true,
  },
  // dev server + `vite preview` only — picks up index.html and receipts.html
  // (the library `build` above is the published-package output and ignores both).
  server: {
    open: "/index.html",
  },
});
