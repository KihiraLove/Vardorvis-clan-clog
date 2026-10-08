/** Mirror production's same-origin /api routing while the frontend runs on Vite. */
import { defineConfig } from 'vite';
export default defineConfig({
  server: { proxy: { '/api': 'http://127.0.0.1:3000' } },
});
