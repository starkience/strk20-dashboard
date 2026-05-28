import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Embed build: same source, bundled as a self-contained UMD with React inlined.
// Drop-in via <script src="embed.js"></script> + <div id="strk20-dashboard"></div>.
export default defineConfig({
  plugins: [react()],
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
  },
  build: {
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, "src/embed.ts"),
      name: "Strk20Embed",
      formats: ["umd"],
      fileName: () => "embed.js",
    },
    sourcemap: true,
  },
});
