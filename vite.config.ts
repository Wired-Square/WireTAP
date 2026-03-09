import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { sentryVitePlugin } from "@sentry/vite-plugin";
import { version } from "./package.json";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [
    {
      name: 'html-version',
      transformIndexHtml(html) {
        return html.replace(/\{\{VERSION\}\}/g, version);
      },
    },
    react(),
    // Upload source maps to Sentry during production builds (requires SENTRY_AUTH_TOKEN)
    sentryVitePlugin({
      authToken: process.env.SENTRY_AUTH_TOKEN,
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      release: { name: `wiretap@${version}` },
      disable: !process.env.SENTRY_AUTH_TOKEN,
    }),
  ],

  // Inject app version as a global constant
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },

  test: {
    include: ["src/**/*.{test,spec}.ts?(x)"],
    globals: false,
    environment: "node",
  },

  // Optimized build configuration for Tauri desktop app
  build: {
    chunkSizeWarningLimit: 500,
    sourcemap: true,
    rollupOptions: {
      output: {
        // Split vendor chunks for better caching
        // Function form matches on resolved file paths (more reliable than object form)
        manualChunks(id) {
          if (id.includes('node_modules/react-dom/') || id.includes('node_modules/react/') || id.includes('node_modules/scheduler/')) {
            return 'vendor-react';
          }
          if (id.includes('node_modules/dockview-core/') || id.includes('node_modules/dockview/')) {
            return 'vendor-dockview';
          }
          if (id.includes('node_modules/@tauri-apps/')) {
            return 'vendor-tauri';
          }
          if (id.includes('node_modules/zustand/')) {
            return 'vendor-zustand';
          }
          if (id.includes('node_modules/smol-toml/')) {
            return 'vendor-toml';
          }
          if (id.includes('node_modules/@sentry/')) {
            return 'vendor-sentry';
          }
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
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
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
