/**
 * 빌드 시 중계 토큰(MV_TOKEN)을 앱에 내장한다.
 *
 * 왜: 통신사 차단 회선용 Worker 중계 폴백(v1.4.5)은 토큰이 있어야 도는데,
 * 태블릿에서 수동 입력시키는 것은 UX 가 아니다. 빌드 기계(이 Mac)의
 * 키체인 `manga-viewer.cloudflare.MV_TOKEN`, 없으면 로컬 시크릿 파일
 * `.dev.vars` 에서 읽어 생성 모듈로 굽는다. 둘 다 .gitignore 대상.
 *
 * 트레이드오프(알고 하는 것): OTA 번들은 인증 없이 받아지므로 내장 토큰은
 * 마음먹으면 꺼낼 수 있다. 개인용 앱 + 프록시는 SSRF 가드됨 + 토큰은
 * `wrangler secret put MV_TOKEN` + 키체인 갱신으로 언제든 로테이트 가능.
 *
 * 토큰을 못 읽으면 빈 값으로 굽지 않고 빌드를 세운다. 예전에는 조용히 빈
 * 문자열을 굽었는데, 그러면 중계 폴백이 죽은 앱이 그대로 OTA 로 나간다
 * (실측: 번들에 `BUILT_IN_PROXY_TOKEN = ""` → 중계 GET 401 → 패널 실패).
 * 실패는 태블릿이 아니라 빌드 기계에서 시끄럽게 나는 쪽이 낫다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, '../src/generated');
const outFile = join(outDir, 'proxyToken.js');
const devVarsFile = join(here, '../.dev.vars');
const KEYCHAIN_SERVICE = 'manga-viewer.cloudflare.MV_TOKEN';

let token = '';
let source = '';

// 1순위: 키체인. 실패 이유(종료 코드)는 에러 메시지에 쓰려고 남긴다.
let keychainStatus = 0;
try {
  token = execFileSync(
    'security',
    ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  ).trim();
  source = '키체인';
} catch (err) {
  keychainStatus = err.status ?? -1;
}

/**
 * 2순위: `.dev.vars`. .gitignore 가 이미 "로컬 시크릿(MV_TOKEN)" 으로
 * 못박아 둔 파일이고 wrangler dev 가 쓰는 값과 같다. 키체인 읽기가
 * 비대화형 셸에서 거부될 때(코드 36) 빌드가 서지 않게 하는 경로.
 */
if (!token) {
  try {
    const hit = readFileSync(devVarsFile, 'utf8').match(/^[ \t]*MV_TOKEN[ \t]*=[ \t]*(.*)$/m);
    if (hit) {
      token = hit[1].trim().replace(/^(['"])(.*)\1$/, '$2');
      if (token) source = '.dev.vars';
    }
  } catch {
    /* 파일이 없으면 아래 실패 처리로 같이 흘러간다 */
  }
}

if (!token) {
  // 종료 코드 36 = errSecInteractionNotAllowed. 항목은 있는데 읽기가 막힌 것 —
  // "없다" 로 오해하고 토큰을 새로 만들면 Worker 쪽과 값이 어긋난다.
  const why = keychainStatus === 36
    ? '36 = 항목은 있으나 비대화형 셸에서 읽기 거부'
    : keychainStatus === 44
      ? '44 = 키체인에 항목 없음'
      : String(keychainStatus);
  console.error(
    '중계 토큰(MV_TOKEN)을 읽지 못했습니다 — 빌드를 중단합니다.\n' +
      '빈 토큰으로 구우면 Worker 중계 폴백이 죽은 앱이 그대로 배포되고,\n' +
      '차단 회선에서 이미지가 통째로 안 뜹니다 (중계 GET 이 401).\n' +
      `  키체인 조회 실패: ${why}\n` +
      `  ${devVarsFile} 에도 MV_TOKEN 없음\n` +
      '\n다음 중 하나를 해주세요:\n' +
      `  1) 키체인에 넣기: security add-generic-password -s ${KEYCHAIN_SERVICE} -a "$USER" -w\n` +
      '     값은 -w 프롬프트에 입력하세요 (인자로 주면 셸 히스토리에 남습니다).\n' +
      '  2) 키체인에 이미 있고 코드가 36 이면, GUI 터미널에서 직접 `npm run build`\n' +
      '     하고 접근 허용 창에서 "항상 허용" 을 누르세요.\n' +
      '     키체인이 잠겨 있으면 `security unlock-keychain` 먼저.\n' +
      '  3) 키체인을 못 쓰는 환경(에이전트·CI)이면 .dev.vars 에 `MV_TOKEN=<토큰>`\n' +
      '     한 줄을 넣으세요 (.gitignore 대상이라 커밋되지 않습니다).\n' +
      '\n값은 Worker 의 `npx wrangler secret put MV_TOKEN` 과 반드시 같아야 합니다.'
  );
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
writeFileSync(
  outFile,
  '// scripts/gen-proxy-token.mjs 가 빌드마다 생성한다. 커밋 금지 (.gitignore).\n' +
    `export const BUILT_IN_PROXY_TOKEN = ${JSON.stringify(token)};\n`
);

console.log(`중계 토큰 내장 완료 (출처 ${source}, 길이 ${token.length})`);
