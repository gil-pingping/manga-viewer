import { defineConfig } from 'vite';
import mangaProxyPlugin from './vite-proxy-plugin.js';

export default defineConfig({
  plugins: [mangaProxyPlugin()],
  server: {
    // 태블릿에서 같은 와이파이로 붙을 수 있게 LAN 바인딩
    host: true,
    port: 5173,
  },
});
