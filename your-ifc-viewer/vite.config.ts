import { defineConfig } from "vite";

export default defineConfig({
  build: {
    target: "es2022", // required for top-level await in main.ts
  },
  server: {
    headers: {
      'Cross-Origin-Resource-Policy': 'cross-origin',
      // Optional: restrict who can embed this app
      'Content-Security-Policy': "frame-ancestors 'self' http://localhost:4200",
    },
  },
});
