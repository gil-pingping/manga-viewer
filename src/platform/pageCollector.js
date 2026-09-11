import { registerPlugin } from '@capacitor/core';
import { buildNativeCollectorScript } from '../collector.js';

const PageCollector = registerPlugin('PageCollector');

/**
 * 네이티브 수집기는 한 번에 한 페이지만 연다 — 겹치면 "이미 다른 페이지를 열고 있습니다"로
 * 거절한다. 다음 화 미리 받기·정주행·다음 화 버튼이 같은 순간에 부르므로(실측: 정주행 중
 * 다음 화가 안 붙고 그 문구가 떴다) 여기서 줄을 세우고, 같은 주소는 한 번만 연다.
 */
const inflight = new Map(); // url → promise
let queue = Promise.resolve();

export function collectRenderedPage(
  targetUrl,
  { silent = false, collect = (options) => PageCollector.collect(options) } = {}
) {
  // ponytail: silent 여부는 먼저 온 호출을 따른다. 로그인 창이 필요하면 다시 누르면 뜬다.
  const shared = inflight.get(targetUrl);
  if (shared) return shared;

  const task = queue.catch(() => {}).then(() => collectOnce(targetUrl, { silent, collect }));
  queue = task;
  inflight.set(targetUrl, task);
  task
    .finally(() => {
      if (inflight.get(targetUrl) === task) inflight.delete(targetUrl);
    })
    .catch(() => {});
  return task;
}

async function collectOnce(targetUrl, { silent, collect }) {
  const options = { url: targetUrl, script: buildNativeCollectorScript(targetUrl), silent: true };
  // 구형 APK는 빈 본문을 기다리지 않고 종료한다. OTA만 받은 기기도 자동 재시도한다.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await collect(options);
    } catch (error) {
      const empty = /이미지를 찾지 못했습니다/.test(error?.message || '');
      const wrongPage = /COLLECTOR_WRONG_PAGE/.test(error?.message || '');
      if ((empty || wrongPage) && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 800));
        continue;
      }
      if (wrongPage) {
        // 어디가 어긋났는지(host·path·파라미터)를 같이 보여준다. 사유 없이 이름만
        // 보이면 맞는 페이지가 떠 있는데도 왜 거절됐는지 알 수 없다.
        const detail = (error?.message || '').split('COLLECTOR_WRONG_PAGE').pop().trim();
        throw new Error(
          '원본 회차가 다른 페이지로 바뀌어 수집하지 못했습니다.'
          + (detail ? `\n어긋난 곳: ${detail}` : ' 원본 주소를 확인해 주세요.')
        );
      }
      /**
       * 여기 오면 네이티브 수집기가 끝나지 않은 호출을 물고 있다. 우리 쪽 호출은 이미
       * 직렬화했으므로 원인은 앱 안이 아니다 — 제한 시간 없는 구형 APK 가 응답 없는
       * 페이지에 걸린 상태다. 그 상태는 앱을 다시 켜야만 풀린다.
       */
      if (/이미 다른 페이지를 열고 있습니다/.test(error?.message || '')) {
        throw new Error('수집기가 앞 페이지에 걸려 있습니다. 앱을 완전히 닫고 다시 열어 주세요 (APK 업데이트가 이 문제를 없앱니다).');
      }
      const needsInteraction = /사이트 응답 (401|403|429)|페이지를 열지 못했습니다/.test(error?.message || '');
      /**
       * 컷을 하나도 못 찾은 경우도 사람에게 넘긴다.
       *
       * 사이트가 컷 자리에 "광고 검증 후 다시 시도해주세요" 같은 관문을 세우면 무음
       * 수집기로는 영원히 빈 결과다. 그 관문은 사람이 통과해야 하는 것이므로 보이는
       * 수집 화면을 띄워 직접 넘기게 한다 — 관문을 뚫는 게 아니라 보여준다.
       * 무음 호출(미리 받기·정주행·자동 재수집)은 사용자가 부른 것이 아니므로 띄우지 않는다.
       */
      if (silent || !(needsInteraction || empty)) throw error;
      return collect({ ...options, silent: false });
    }
  }
}
