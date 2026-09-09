import { registerPlugin } from '@capacitor/core';
import { buildNativeCollectorScript } from '../collector.js';

const PageCollector = registerPlugin('PageCollector');

export async function collectRenderedPage(targetUrl, { silent = false } = {}) {
  const options = { url: targetUrl, script: buildNativeCollectorScript(), silent: true };
  // 구형 APK는 빈 본문을 기다리지 않고 종료한다. OTA만 받은 기기도 자동 재시도한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await PageCollector.collect(options);
    } catch (error) {
      const empty = /이미지를 찾지 못했습니다/.test(error?.message || '');
      if (empty && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      const needsInteraction = /사이트 응답 (401|403|429)|페이지를 열지 못했습니다/.test(error?.message || '');
      if (empty || silent || !needsInteraction) throw error;
      // 로그인·인증이 필요한 경우에만 기존 수동 화면으로 넘긴다.
      return PageCollector.collect({ ...options, silent: false });
    }
  }
}
