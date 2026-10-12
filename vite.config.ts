import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', port: 5178, strictPort: true, watch: { ignored: ['**/output/**', '**/android/**', '**/.playwright-cli/**'] } }, build: { target: 'es2022', rolldownOptions: { output: { chunkFileNames: chunk=>`assets/${chunk.name.replace(/^\.+/,'')}-[hash].js` } } } });
