/**
 * 빌드 시 macOS Keychain 의 MV_TOKEN 을 앱에 내장한다.
 *
 * 왜: 통신사 차단 회선용 Worker 중계 폴백(v1.4.5)은 토큰이 있어야 도는데,
 * 태블릿에서 수동 입력시키는 것은 UX 가 아니다. 빌드 기계(이 Mac)의
 * 키체인 `manga-viewer.cloudflare.MV_TOKEN` 에서 읽어 생성 모듈로 굽는다.
 *
 * 트레이드오프(알고 하는 것): OTA 번들은 인증 없이 받아지므로 내장 토큰은
 * 마음먹으면 꺼낼 수 있다. 개인용 앱 + 프록시는 SSRF 가드됨 + 토큰은
 * `wrangler secret put MV_TOKEN` + 키체인 갱신으로 언제든 로테이트 가능.
 *
 * 키체인이 없는 환경(CI 등)에서는 빈 문자열로 굽는다 — 빌드는 계속 되고
 * 폴백만 비활성(설정 화면 수동 입력은 여전히 동작).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../src/generated');
const outFile = join(outDir, 'proxyToken.js');

let token = '';
try {
  token = execFileSync(
    'security',
    ['find-generic-password', '-s', 'manga-viewer.cloudflare.MV_TOKEN', '-w'],
    { encoding: 'utf8' }
  ).trim();
} catch {
  /* 키체인이 없으면 빈 토큰으로 굽는다 */
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  outFile,
  '// scripts/gen-proxy-token.mjs 가 빌드마다 생성한다. 커밋 금지 (.gitignore).\n' +
    `export const BUILT_IN_PROXY_TOKEN = ${JSON.stringify(token)};\n`
);

console.log(token ? `중계 토큰 내장 완료 (길이 ${token.length})` : '키체인에 토큰 없음 — 빈 값으로 생성');
