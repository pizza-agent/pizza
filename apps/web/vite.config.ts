import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pizzaRpcBridge } from "./scripts/dev-bridge.mjs";
import path from "node:path";

export default defineConfig({
	plugins: [react(), tailwindcss(), pizzaRpcBridge()],
	clearScreen: false,
	server: {
		port: 1420,
		strictPort: true,
		host: "127.0.0.1",
	},
	envPrefix: ["VITE_", "TAURI_"],
	resolve: {
		alias: {
			"@": path.resolve(__dirname, "./src"),
			"@tomsun28/pizza-protocol": path.resolve(__dirname, "../../packages/protocol/index.ts"),
		},
	},
	build: {
		target: "es2022",
		outDir: "dist",
		emptyOutDir: true,
		rollupOptions: {
			input: {
				main: path.resolve(__dirname, "index.html"),
				pet: path.resolve(__dirname, "pet.html"),
			},
			output: {
				manualChunks: {
					react: ["react", "react-dom", "react-router-dom", "react-i18next", "i18next"],
					xterm: ["@xterm/xterm", "@xterm/addon-fit"],
					markdown: ["react-markdown", "remark-gfm", "highlight.js"],
					lucide: ["lucide-react"],
				},
			},
		},
		chunkSizeWarningLimit: 700,
	},
});
