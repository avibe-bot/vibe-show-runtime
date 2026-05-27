import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  build: {
    lib: {
      entry: {
        index: "src/index.ts",
        button: "src/button.tsx",
        card: "src/card.tsx",
        badge: "src/badge.tsx",
        dialog: "src/dialog.tsx",
        input: "src/input.tsx",
        progress: "src/progress.tsx",
        switch: "src/switch.tsx",
        theme: "src/theme.tsx",
        utils: "src/utils.ts"
      },
      formats: ["es"]
    },
    rollupOptions: {
      external: ["react", "react-dom", "react/jsx-runtime"]
    },
    cssCodeSplit: false
  }
})
