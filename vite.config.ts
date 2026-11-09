import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { workerDev } from "./scripts/dev-worker.ts";

export default defineConfig({
  plugins: [solid(), workerDev()],
  // Keep the HEIC decoder lazy inside the image worker as well as the UI fallback.
  worker: { format: "es" },
  build: { outDir: "dist/client", chunkSizeWarningLimit: 1500 },
});
