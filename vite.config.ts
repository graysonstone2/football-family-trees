import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react-swc'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // Local coach-comp API (scripts/coach-comp-dev-server.mjs); in production
      // /api/coach-comp is served as a serverless function.
      '/api': 'http://localhost:8787',
    },
  },
})
