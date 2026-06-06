import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { createShadcnAlias } from "@avibe/show-runtime"

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: createShadcnAlias()
  }
})
