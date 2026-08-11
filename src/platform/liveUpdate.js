import { LiveUpdate } from '@capawesome/capacitor-live-update';
import { CapacitorHttp } from '@capacitor/core';
import { NATIVE_VERSION, OTA_ORIGIN, validateOtaManifest } from '../core/otaManifest.js';
import { isNativeApp } from './nativeHttp.js';

const MANIFEST_URL = `${OTA_ORIGIN}/ota/latest.json`;

/** 현재 적용되어 있는 LiveUpdate 번들 ID 반환 */
export async function getCurrentBundleId() {
  if (!isNativeApp()) return 'web-dev';
  try {
    const { bundleId } = await LiveUpdate.getCurrentBundle();
    return bundleId || 'web-apk-default';
  } catch {
    return 'web-native';
  }
}

/**
 * JS가 돌기 시작했다 = 번들은 정상이다. 부팅 맨 앞에서 즉시 호출한다.
 *
 * 예전엔 서재 복원·챕터 열기까지 끝난 뒤에야 ready()를 불렀는데, 이 기기에서
 * webview 렌더러가 가끔 늦게/못 뜨면 10초 롤백 타이머에 걸려 멀쩡한 번들이
 * 롤백 후 영구 차단됐다(역대 번들 8개 전멸). ready()는 데이터 로딩과 무관하게
 * 최대한 일찍 불러야 한다.
 */
export async function confirmBundleReady() {
  if (!isNativeApp()) return;
  const ready = await LiveUpdate.ready();
  if (ready.rollback) console.warn('[OTA] 깨진 번들을 기본 APK로 되돌렸습니다.');
  // autoBlock 시절 영구 차단된 번들들을 복구한다. 차단은 더 이상 쌓이지 않으므로
  // 매 부팅 호출해도 사실상 no-op.
  await LiveUpdate.clearBlockedBundles().catch(() => {});
}

/** 있으면 서명된 새 웹 번들로 한 번 재시작한다. confirmBundleReady() 이후에 호출할 것. */
export async function finishStartupAndApplyUpdate({ beforeReload } = {}) {
  if (!isNativeApp()) return false;

  const response = await CapacitorHttp.get({
    url: `${MANIFEST_URL}?v=${Date.now()}`,
    headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
    responseType: 'json',
    connectTimeout: 10000,
    readTimeout: 10000,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`OTA manifest를 받지 못했습니다 (${response.status}).`);
  }

  const manifest = validateOtaManifest(response.data, {
    origin: OTA_ORIGIN,
    nativeVersion: NATIVE_VERSION,
  });
  const [{ bundleId: currentBundleId }, { bundleId: nextBundleId }] = await Promise.all([
    LiveUpdate.getCurrentBundle(),
    LiveUpdate.getNextBundle(),
  ]);

  // ponytail: 부팅 즉시 죽는 번들을 배포하면 롤백↔재설치가 반복된다. 서명 파이프라인이
  // 빌드·테스트 통과본만 내보내므로 감수 — 재발 시 번들별 재시도 쿨다운 추가.
  if (currentBundleId === manifest.bundleId) return false;
  if (nextBundleId !== manifest.bundleId) {
    const downloaded = await LiveUpdate.getDownloadedBundles();
    if (!downloaded.bundleIds.includes(manifest.bundleId)) {
      await LiveUpdate.downloadBundle({
        bundleId: manifest.bundleId,
        url: manifest.url,
        checksum: manifest.checksum,
        signature: manifest.signature,
      });
    }
    await LiveUpdate.setNextBundle({ bundleId: manifest.bundleId });
  }

  await beforeReload?.();
  await LiveUpdate.reload();
  return true;
}
