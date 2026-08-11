import LZString from 'lz-string';
import { parse } from 'zipson';
import { assertAnilifeWatchId } from '../shared/anilifeRules.js';

const AES_KEY_HEX = '5f1d6b5cf2b6e5a236aa6352c5e688bc86c257a9b61b183c9926613a90356a48';
const HMAC_KEY_HEX = '3f8d7b6a4c2e1d9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f';
const ENVELOPE_MAX_AGE_MS = 5 * 60 * 1000;
const VOD_ORIGIN = 'https://api.gcdn.app';

function bytesFromHex(hex) {
  if (typeof hex !== 'string' || hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error('애니 재생 서명이 올바르지 않습니다.');
  }
  return Uint8Array.from(hex.match(/../g), (byte) => Number.parseInt(byte, 16));
}

function bytesFromBase64(value) {
  const decoded = atob(value);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

function concatBytes(...parts) {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.byteLength;
  }
  return result;
}

function parseEnvelope(rawText) {
  const decompressed = LZString.decompressFromUTF16(rawText);
  if (!decompressed) throw new Error('애니 재생 응답 압축을 풀지 못했습니다.');
  const envelope = parse(decompressed);
  if (!Array.isArray(envelope) || envelope.length !== 5 || envelope.some((part) => typeof part !== 'string')) {
    throw new Error('애니 재생 응답 형식이 올바르지 않습니다.');
  }
  return envelope;
}

export async function decryptAnilifeMedia(rawText) {
  if (!globalThis.crypto?.subtle) {
    throw new Error('애니 재생은 HTTPS 또는 localhost에서만 지원됩니다.');
  }
  const [ciphertextText, ivText, tagText, timestampText, signatureText] = parseEnvelope(rawText);
  const ciphertext = bytesFromBase64(ciphertextText);
  const iv = bytesFromBase64(ivText);
  const tag = bytesFromBase64(tagText);
  const timestampRaw = atob(timestampText);
  const timestamp = Number(timestampRaw);

  if (!Number.isSafeInteger(timestamp) || Math.abs(Date.now() - timestamp) > ENVELOPE_MAX_AGE_MS) {
    throw new Error('애니 재생 링크가 만료됐습니다. 다시 열어 주세요.');
  }

  const signed = concatBytes(ciphertext, iv, tag, new TextEncoder().encode(timestampRaw));
  const hmacKey = await crypto.subtle.importKey(
    'raw',
    bytesFromHex(HMAC_KEY_HEX),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );
  const verified = await crypto.subtle.verify(
    'HMAC',
    hmacKey,
    bytesFromHex(signatureText),
    signed
  );
  if (!verified) throw new Error('애니 재생 응답 서명 검증에 실패했습니다.');

  const aesKey = await crypto.subtle.importKey(
    'raw',
    bytesFromHex(AES_KEY_HEX),
    { name: 'AES-GCM' },
    false,
    ['decrypt']
  );
  let decrypted;
  try {
    decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, tagLength: 128 },
      aesKey,
      concatBytes(ciphertext, tag)
    );
  } catch {
    throw new Error('애니 재생 응답 복호화에 실패했습니다.');
  }

  try {
    return JSON.parse(new TextDecoder().decode(decrypted));
  } catch {
    throw new Error('애니 재생 정보 JSON이 올바르지 않습니다.');
  }
}

function chapterRange(start, end) {
  const from = Number(start);
  const to = Number(end);
  return Number.isFinite(from) && Number.isFinite(to) && from >= 0 && to > from
    ? { startTime: from === 1 ? 0 : from, endTime: to }
    : null;
}

function navigationItem(item) {
  if (!item?.uniqueId) return null;
  try {
    return {
      id: assertAnilifeWatchId(item.uniqueId),
      episodeNumber: Number(item.episode_num) || 0,
      episodeTitle: typeof item.subject === 'string' ? item.subject : '',
      posterUrl: typeof item.thumbnail === 'string' ? item.thumbnail : '',
    };
  } catch {
    return null;
  }
}

export function buildAnilifePlayback(data, id) {
  assertAnilifeWatchId(id);
  const access = data?.access;
  if (
    typeof access !== 'string' ||
    access.length < 20 ||
    access.length > 4096 ||
    !/^[A-Za-z0-9_/-]+$/.test(access)
  ) {
    throw new Error('애니 스트림 주소가 올바르지 않습니다.');
  }

  const episode = data?.episode || {};
  const media = data?.media || {};
  return {
    id,
    sourceUrl: `https://anilife.app/watch?id=${id}`,
    streamUrl: `${VOD_ORIGIN}/v1/manifest/a/${access}/master.m3u8`,
    seriesTitle: media.name?.kr || media.name?.en || '애니메이션',
    episodeNumber: Number(episode.episode_num) || 1,
    episodeTitle: typeof episode.subject === 'string' ? episode.subject : '',
    posterUrl: episode.thumbnail || media.image || '',
    timestamps: {
      op: chapterRange(episode.op_start, episode.op_end),
      ed: chapterRange(episode.ed_start, episode.ed_end),
    },
    navigation: {
      prev: navigationItem(data?.navigation?.prev),
      next: navigationItem(data?.navigation?.next),
    },
  };
}
