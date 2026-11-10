import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 520,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes('node_modules/three/examples/jsm/postprocessing/') ||
            id.includes('node_modules/three/examples/jsm/environments/RoomEnvironment.js')
          ) {
            return 'three-postprocessing';
          }
          if (id.includes('node_modules/three/')) return 'three';
        },
      },
    },
  },
});
