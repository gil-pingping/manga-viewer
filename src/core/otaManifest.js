export const OTA_ORIGIN = 'https://manga-viewer.giyun.workers.dev';
export const NATIVE_VERSION = 4;

/** 원격 코드는 네이티브 권한을 쓰므로 형식·출처를 모두 고정한다. */
export function validateOtaManifest(raw, options = {}) {
  const origin = options.origin || OTA_ORIGIN;
  const nativeVersion = options.nativeVersion || NATIVE_VERSION;

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('OTA manifest가 객체가 아닙니다.');
  }
  if (raw.schemaVersion !== 1) throw new Error('지원하지 않는 OTA manifest 버전입니다.');
  if (raw.nativeVersion !== nativeVersion) {
    throw new Error('현재 APK와 호환되지 않는 OTA 번들입니다.');
  }
  if (!/^web-[a-f0-9]{20}$/.test(raw.bundleId || '')) {
    throw new Error('OTA bundleId 형식이 잘못됐습니다.');
  }
  if (!/^[a-f0-9]{64}$/.test(raw.checksum || '')) {
    throw new Error('OTA checksum 형식이 잘못됐습니다.');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw.signature || '')) {
    throw new Error('OTA signature 형식이 잘못됐습니다.');
  }

  let url;
  try {
    url = new URL(raw.url);
  } catch {
    throw new Error('OTA 번들 URL이 잘못됐습니다.');
  }
  const expectedPath = `/ota/${raw.bundleId}.zip`;
  if (url.protocol !== 'https:' || url.origin !== origin || url.pathname !== expectedPath) {
    throw new Error('허용되지 않은 OTA 번들 URL입니다.');
  }

  return {
    bundleId: raw.bundleId,
    checksum: raw.checksum,
    signature: raw.signature,
    url: url.href,
  };
}
