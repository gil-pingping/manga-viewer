import { registerPlugin } from '@capacitor/core';
import { buildNativeCollectorScript } from '../collector.js';

const PageCollector = registerPlugin('PageCollector');

export async function collectRenderedPage(targetUrl, { silent = false } = {}) {
  const options = { url: targetUrl, script: buildNativeCollectorScript(targetUrl), silent: true };
  // 구형 APK는 빈 본문을 기다리지 않고 종료한다. OTA만 받은 기기도 자동 재시도한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await PageCollector.collect(options);
    } catch (error) {
      const empty = /이미지를 찾지 못했습니다/.test(error?.message || '');
      const wrongPage = /COLLECTOR_WRONG_PAGE/.test(error?.message || '');
      if ((empty || wrongPage) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      if (wrongPage) throw new Error('원본 회차가 다른 페이지로 바뀌어 수집하지 못했습니다. 원본 주소를 확인해 주세요.');
      const needsInteraction = /사이트 응답 (401|403|429)|페이지를 열지 못했습니다/.test(error?.message || '');
      if (empty || silent || !needsInteraction) throw error;
      // 로그인·인증이 필요한 경우에만 기존 수동 화면으로 넘긴다.
      return PageCollector.collect({ ...options, silent: false });
    }
  }
}
