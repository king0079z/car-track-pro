import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/** Dev proxy → FastAPI (deploy.cmd uses port 8001). Long timeouts for YOLO jobs. */
const backendProxy = {
  target: 'http://localhost:8001',
  changeOrigin: true,
  timeout: 600_000,
  proxyTimeout: 600_000,
}

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // CarTrack REST API
      '/api': backendProxy,
      // CarTrack WebSocket
      '/ws': {
        ...backendProxy,
        target: 'ws://localhost:8001',
        ws: true,
      },
      // VisionFlow REST API
      '/vf': backendProxy,
      // VisionFlow static analyzer UI  (/analyzer/ and /analyzer/history)
      '/analyzer': backendProxy,
      // VisionFlow shared CSS / assets served at /static/
      '/static': backendProxy,
    },
  },
})
