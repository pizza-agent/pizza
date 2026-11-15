import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({ plugins: [react(), tailwindcss()], build: { sourcemap: false }, server: { host: '127.0.0.1', port: 4175, strictPort: true } });
