import { defineConfig } from 'vite';
import mangaProxyPlugin from './vite-proxy-plugin.js';

export default defineConfig({
  plugins: [mangaProxyPlugin()],
  // 수집 규칙은 함수 소스를 외부 WebView에 주입한다. 이름을 축약하면 주입된 코드의
  // 함수 참조가 끊긴다. 앱 전체가 300KB 미만이라 압축보다 동작 보존이 중요하다.
  build: { minify: false },
  server: {
    // 맥에서 고치는 동안 태블릿으로 확인할 수 있게 LAN 바인딩
    host: true,
    port: 5173,
  },

  /**
   * 태블릿이 자기 자신에게서 앱을 띄우는 모드 (`npm run serve`).
   * 일부러 localhost 만 연다. 두 가지 이유가 있다:
   *
   * 1. IndexedDB 는 오리진마다 별개다. 태블릿이 어떤 날은 자기 localhost,
   *    어떤 날은 맥의 LAN 주소로 열면 **서재가 둘로 갈린다** — 담아둔 화가
   *    사라진 것처럼 보인다. 오리진을 하나로 못박아 그 실수를 없앤다.
   * 2. localhost 는 secure context 라서 서비스워커가 켜진다 (LAN http 는 안 된다).
   *    같은 와이파이의 다른 기기가 이 프록시를 쓰지 못하게 하는 효과도 있다.
   *
   * preview.host 는 기본값이 server.host 라서, 명시하지 않으면 LAN 에 열린다.
   */
  preview: {
    host: 'localhost',
    port: 4173,
  },
});
