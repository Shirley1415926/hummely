import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // Pinggy forwards its own hostname while the temporary phone test is active.
  preview: {
    allowedHosts: [".pinggy-free.link", ".free.pinggy.net"]
  }
});
