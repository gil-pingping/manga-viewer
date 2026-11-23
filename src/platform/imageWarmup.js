/**
 * 다음 화 첫 컷을 미리 받아두는 캐시.
 *
 * 왜 필요한가 (한 장·두 장 정주행의 로딩): 세로 스크롤 정주행은 다음 화를 같은 엔진
 * 아래에 붙이므로, 읽어 내려가는 동안 그 화 컷이 차례로 받아진다. 페이지 넘김은 붙일
 * 자리가 없어 마지막 장에서 다음 화를 새로 연다 — 그 순간 엔진이 캐시를 비우고
 * 1쪽부터 네이티브 HTTP 로 다시 받는다. 그게 화 경계의 로딩이었다.
 *
 * 예전 preloadChapterImages 는 `new Image().src = '/api/proxy-image?...'` 였는데,
 * APK 에서는 그 주소를 받아줄 서버가 없어(이미지는 네이티브 HTTP 로 받는다) 아무것도
 * 미리 받지 못했다.
 *
 * 그래서 엔진이 쓰는 resolve 함수 자체를 앞당겨 부르고 결과(blob 주소)를 쥐고 있다가,
 * 엔진이 같은 컷을 요청하면 그대로 넘긴다. 넘긴 blob 은 엔진 소유가 되어 엔진이 놓는다.
 * 끝내 안 쓰인 것은 여기서 놓는다 — 안 놓으면 컷 바이트가 메모리에 남는다.
 */
export function createImageWarmup(resolve, { limit = 8 } = {}) {
  /** page.url → Promise<{url, owned}> (삽입 순서 = 오래된 순) */
  const pending = new Map();

  const keyOf = (page) => page?.url || '';

  function release(promise) {
    promise
      .then((resolved) => {
        if (resolved?.owned && resolved.url) URL.revokeObjectURL(resolved.url);
      })
      .catch(() => {});
  }

  return {
    /**
     * 이 컷들을 미리 받는다. 목록에 없는 예전 대기분은 놓는다
     * (다음 화가 바뀌었으면 앞 예측은 쓸모가 없다).
     */
    warm(pages) {
      const wanted = (pages || []).filter((page) => keyOf(page)).slice(0, limit);
      const keys = new Set(wanted.map(keyOf));

      for (const [key, promise] of pending) {
        if (!keys.has(key)) {
          pending.delete(key);
          release(promise);
        }
      }

      for (const page of wanted) {
        const key = keyOf(page);
        if (pending.has(key)) continue;
        const promise = Promise.resolve().then(() => resolve(page));
        promise.catch(() => {}); // 실패는 엔진이 요청할 때 다시 받는다
        pending.set(key, promise);
      }
    },

    /** 엔진의 resolvePageUrl. 미리 받아둔 게 있으면 넘겨주고, 없거나 실패했으면 새로 받는다 */
    resolve(page) {
      const key = keyOf(page);
      const promise = pending.get(key);
      if (!promise) return resolve(page);
      pending.delete(key);
      return promise.catch(() => resolve(page));
    },

    /** 서재 삭제 등으로 예측이 무효가 됐을 때 */
    clear() {
      for (const promise of pending.values()) release(promise);
      pending.clear();
    },

    get size() {
      return pending.size;
    },
  };
}
