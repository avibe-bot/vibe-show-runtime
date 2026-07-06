import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { createShadcnAlias } from "@avibe/show-runtime"

// This example renders @avibe/show-ui components, which are now styled with Tailwind
// utilities from the theme — so it needs the Tailwind plugin, like the runtime and any
// consumer. (src/styles.css imports tailwindcss + the theme.)
export default defineConfig({
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: createShadcnAlias()
  }
})
