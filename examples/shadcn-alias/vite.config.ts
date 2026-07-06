import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { createShadcnAlias } from "@avibe/show-runtime"

// Mirrors the runtime's plugin set (see packages/runtime/src/runtime.ts) so the example
// exercises the Tailwind build path the same way public /p/ pages are served without HMR.
export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: createShadcnAlias()
  }
})
