import { LiveUpdate } from '@capawesome/capacitor-live-update';
import { CapacitorHttp } from '@capacitor/core';
import { NATIVE_VERSION, OTA_ORIGIN, validateOtaManifest } from '../core/otaManifest.js';
import { isNativeApp } from './nativeHttp.js';

const MANIFEST_URL = `${OTA_ORIGIN}/ota/latest.json`;

/** 앱이 정상 부팅했음을 알린 뒤, 있으면 서명된 새 웹 번들로 한 번 재시작한다. */
export async function finishStartupAndApplyUpdate() {
  if (!isNativeApp()) return false;

  const ready = await LiveUpdate.ready();
  if (ready.rollback) console.warn('[OTA] 깨진 번들을 기본 APK로 되돌렸습니다.');

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
  const [{ bundleId: currentBundleId }, { bundleId: nextBundleId }, blocked] = await Promise.all([
    LiveUpdate.getCurrentBundle(),
    LiveUpdate.getNextBundle(),
    LiveUpdate.getBlockedBundles(),
  ]);

  if (currentBundleId === manifest.bundleId) return false;
  if (blocked.bundleIds.includes(manifest.bundleId)) {
    console.warn(`[OTA] 롤백된 번들은 다시 설치하지 않습니다: ${manifest.bundleId}`);
    return false;
  }
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

  await LiveUpdate.reload();
  return true;
}
