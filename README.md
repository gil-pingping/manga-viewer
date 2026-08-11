# Manga Viewer

8.4인치 Android 태블릿에서 만화·웹툰·이미지 묶음을 읽는 개인용 뷰어.

페이지 주소 하나를 넣으면 본문 이미지를 찾고, 한 장·두 장·세로 스크롤 모드로 보여준다.
Cloudflare 웹앱, Android APK, Termux 로컬 서버 세 경로를 지원한다. 권장 경로는 Android APK다.

## 현재 검증된 배포

- Android APK: **v1.3** (`versionCode 4`)
- Android OTA: **v1.4.0** (`web-2a1545230fd27439a723`)
- Cloudflare Worker: `93f0257d-7dd0-4de9-979c-f83c1a897499`
- 자동 테스트: JavaScript 136개 + Android 수집 회귀 테스트
- 태블릿 실측: 원본 15장 수집, 다음 화 12장 전환, 프리로드된 다음 화 이동 54ms

## 주요 기능

- 웹툰·만화 페이지 주소에서 본문 이미지 자동 수집
- JavaScript 렌더링·로그인 페이지를 Android WebView로 자동 처리
- 원본 사이트와 자동 스크롤 장면을 가리는 네이티브 수집 화면
- 현재 화를 읽는 동안 다음 화 백그라운드 프리로드
- 이전 화·다음 화 이동
- 한 장·두 장·세로 스크롤, RTL/LTR, 확대, 스와이프, 자동 넘김
- CBZ·ZIP·여러 이미지 파일 열기
- IndexedDB 오프라인 서재와 10화 연속 저장
- 서비스워커 기반 오프라인 앱 부팅
- Cloudflare Worker 인증·페이지 프록시·이미지 프록시
- 애니라이프 watch 주소 저장 및 앱 내부 HLS 영상 재생
- RSA 서명 + SHA-256 검증 Android 웹 번들 OTA

## 가장 빠른 사용법 — Android APK

### 1. 빌드·설치

```sh
npm ci
npm test
npm run android:build
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

ADB 없이 APK 파일을 태블릿으로 옮겨 설치해도 된다. 상세 절차: [ANDROID.md](ANDROID.md).

### 2. 만화 불러오기

1. 앱에서 **주소 붙여넣기 · 북마클릿**을 누른다.
2. 회차 페이지 주소를 넣고 **불러오기**를 누른다.
3. 로그인이 필요하면 **로그인 · 페이지 보기**를 누르고 사이트 로그인을 끝낸다.
4. 자동 수집이 끝나면 뷰어로 돌아온다.

Android 앱은 페이지 HTML과 이미지 요청을 태블릿에서 직접 보낸다. Cloudflare 데이터센터 IP만
막는 사이트도 태블릿 네트워크가 허용되면 동작한다.

### 3. VPN이 필요한 사이트

VPN 앱의 앱별 대상 목록에 **Chrome뿐 아니라 Manga Viewer도 넣는다**. Chrome만 넣으면
브라우저는 열리지만 앱 WebView·네이티브 HTTP는 `ERR_CONNECTION_RESET` 또는 403이 난다.

VPN이 사이트의 계정·CAPTCHA·기기 인증·지역 정책을 무효화하지는 않는다. 해당 절차는 앱 안
WebView에서 직접 끝내야 한다.

## 수집 흐름

### 1. 정적 HTML 우선

네이티브 HTTP 또는 Worker가 페이지 HTML을 받고 `DOMParser`로 파싱한다. DOM은 이미지
서술자로 바뀌고, 모든 진입 경로가 `src/core/imageRules.js`의 같은 선별 규칙을 쓴다.

선별 우선순위:

1. 사이트가 제공한 페이지 번호
2. 같은 폴더의 연속 파일 번호
3. 같은 파일명 모양
4. 디렉터리 다수결

광고 규격, 아이콘, 로고, 오디오·문서 확장자, 작은 이미지는 제외한다.

### 2. 작은 결과는 성공으로 확정하지 않는다

일부 사이트 정적 HTML에는 실제 컷 대신 광고나 placeholder 1장만 있다. 이를 성공으로 받으면
`1 / 1`만 보인다.

Android에서는 정적 결과가 0~2장이면 WebView 렌더 수집으로 전환한다. WebView도 첫 DOM
검사에서 0~2장만 보이면 성공하지 않고 숨은 자동 스크롤을 끝까지 실행한다. 스크롤 뒤에도
남은 결과가 없을 때만 로그인 안내를 보여준다.

### 3. WebView는 렌더하되 보여주지 않는다

`WebView.INVISIBLE`이나 `GONE`은 레이아웃·lazy loading을 멈출 수 있다. WebView는 실제 화면
크기로 렌더하고, 그 위를 불투명 네이티브 화면으로 덮는다.

순서:

1. `onPageFinished` 300ms 뒤 즉시 DOM 수집
2. 결과 0~2장이면 최대 30틱 숨은 스크롤
3. 맨 위로 복귀 후 최종 수집
4. 실패하거나 로그인이 필요할 때만 사용자가 원본 페이지를 직접 연다

### 4. 다음 화 백그라운드 프리로드

현재 화를 열면 `nextUrl`을 silent WebView로 미리 수집한다. silent 창은 투명·비포커스·터치
통과 상태라 읽기를 막지 않는다.

프리로드 결과는 `sourceId + nextUrl`이 현재 이동과 모두 일치할 때만 쓴다. 이전 화에서 늦게
끝난 Promise가 현재 화로 섞이지 않는다. 프리로드가 실패하면 알림 없이 버리고, 실제 다음 화
클릭 때 로그인 가능한 일반 수집 경로로 재시도한다.

## 이미지 표시와 오프라인 저장

이미지 호스트는 Referer·User-Agent를 검사하고 CORS 헤더를 주지 않는 경우가 많다.

- 웹앱: Worker `/api/proxy-image?url=&ref=`가 원본 Referer로 중계한다.
- Android: 태블릿 네이티브 HTTP가 원본 이미지와 Referer를 직접 보낸다.
- 오프라인 서재: 응답 바이트를 IndexedDB에 저장하고 읽을 때 blob URL로 복원한다.

서재 데이터는 서버에 없다. 브라우저·앱 오리진별 IndexedDB 안에만 있다. 앱 껍데기와 Vite
해시 자산은 서비스워커 install 단계에서 함께 캐시하므로 첫 온라인 실행 뒤 서버가 없어도
부팅한다.

오프라인 검증은 **새 프로필에서 한 번만 온라인으로 연 뒤 바로 네트워크를 차단**한다. 중간
온라인 새로고침은 캐시를 채워 실패를 숨긴다.

## 로컬 개발

요구 사항: Node.js 20+, npm.

```sh
npm ci
npm run dev
```

기본 개발 주소: `http://localhost:5173`.

```sh
npm test              # JS 회귀 테스트
npm run build         # Vite 빌드 + 수집 함수 이름 검증
npm run android:build # 웹 동기화 + Android debug APK
```

Android 단위 테스트는 JDK 21 환경에서 실행한다.

```sh
cd android
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  ./gradlew :app:testDebugUnitTest
```

## Cloudflare 배포

```sh
npx wrangler secret put MV_TOKEN  # 첫 배포 또는 토큰 교체
npm run ota:key                   # 첫 APK/OTA 설정에서 한 번
npm test && npm run deploy        # 웹 + 서명 OTA + Worker
```

프로덕션: `https://manga-viewer.giyun.workers.dev`

최초 접속은 `?t=<토큰>` 주소를 한 번 사용한다. 토큰은 HttpOnly·Secure 쿠키로 바뀌고 주소에서
제거된다. 토큰·OTA 개인키는 저장소에 커밋하지 않는다.

- OTA 개인키: `~/.config/manga-viewer/ota-private.pem` — 암호화 백업, 권한 `600`
- OTA 공개키: `keys/ota-public.pem` — APK 검증용, 저장소에 커밋
- Worker 토큰: Cloudflare `MV_TOKEN` secret — 파일로 저장하지 않음

배포 실패 시:

```sh
npx wrangler rollback
```

상세 배포·팀 공유·Cloudflare Access 선택 기준: [DEPLOY.md](DEPLOY.md).

## Android OTA

일반 HTML/CSS/JavaScript 수정은 APK 재설치 없이 `npm run deploy`로 전달된다. 앱은 시작 시
고정 Worker 오리진의 manifest를 읽고 다음을 모두 검증한다.

- manifest schema
- APK `NATIVE_VERSION` 호환성
- 고정 HTTPS 오리진과 `/ota/<bundleId>.zip` 경로
- SHA-256 checksum
- RSA signature
- 과거 rollback으로 차단된 bundle 여부

Java 플러그인·Capacitor 의존성·Android 권한·공개키 변경은 APK 버전과 `NATIVE_VERSION`을 같이
올리고 APK를 다시 설치한다.

## Cloudflare 웹판과 Termux

웹판은 설치 없이 쓸 수 있고 PWA로 홈 화면에 추가할 수 있다. Worker에는 브라우저가 없으므로
JavaScript가 이미지를 나중에 만드는 사이트나 로그인이 필요한 페이지는 북마클릿을 사용한다.

APK를 설치할 수 없으면 태블릿 Termux에서 `npm run serve`를 실행한다. 항상
`http://localhost:4173`을 사용한다. 주소를 바꾸면 IndexedDB 서재가 갈리고 LAN HTTP에서는
서비스워커가 동작하지 않는다. 상세 절차: [TABLET.md](TABLET.md).

## 구조

| 경로 | 책임 |
|---|---|
| `main.js` | UI 배선, 챕터 이동, 다음 화 프리로드 |
| `src/urlHarvester.js` | URL·북마클릿·텍스트·파일 수집 진입점 |
| `src/core/imageRules.js` | 본문 이미지 선별 단일 진실 |
| `src/core/layout.js` | 보기 모드·펼침·페이지 배치 |
| `src/core/chapterNav.js` | 이전/다음 화 탐색과 프리로드 일치 판정 |
| `src/collect/fromDocument.js` | DOM을 이미지 서술자로 변환 |
| `src/readerEngine.js` | 이미지 렌더, 제스처, 인접 페이지 캐시 |
| `src/library.js` | IndexedDB 오프라인 서재 |
| `src/platform/nativeHttp.js` | Android HTML·이미지 직접 요청 |
| `src/platform/pageCollector.js` | Java PageCollector 플러그인 어댑터 |
| `src/platform/liveUpdate.js` | Android 서명 OTA 적용·롤백 |
| `android/.../PageCollectorPlugin.java` | 로그인 WebView, 덮개, 숨은 스크롤, silent 수집 |
| `src/shared/proxyRules.js` | Node·Worker 공용 URL·Referer·상류 요청 규칙 |
| `vite-proxy-plugin.js` | 로컬 Node 프록시 |
| `worker/index.js` | Cloudflare 인증·페이지·이미지 프록시 |
| `public/sw.js` | 앱 껍데기·Vite 자산 오프라인 캐시 |

핵심 원칙: **판단은 순수 함수, DOM·Android·서버 접촉은 얇은 어댑터**. 같은 선별 규칙을
북마클릿, HTML 파서, Android WebView가 재사용한다.

## 보안 경계

- URL은 공개 HTTP/HTTPS만 허용한다.
- localhost, 사설망, link-local, CGNAT, 특수 목적 주소를 프록시에서 차단한다.
- DNS 검사 뒤 같은 공개 IP로 연결해 DNS rebinding 틈을 막는다.
- 원격 SVG를 same-origin 문서로 실행하지 않도록 응답을 sandbox 처리한다.
- Worker `MV_TOKEN`이 없으면 모든 `/api`를 503으로 닫는다.
- Android WebView는 file/content 접근, mixed content, 임의 새 창을 막는다.
- 봇 차단·CAPTCHA·사이트 접근 정책을 우회하는 코드는 제공하지 않는다.

본인이 접근 권한을 가진 콘텐츠와 사이트 약관 범위에서 사용한다.

## 문제 해결

### 광고 1장만 보임 (`1 / 1`)

APK v1.2 이하 또는 호환되지 않는 구 OTA에서 정적 광고 1장을 성공으로 오판한 회귀다.
APK v1.3 이상을 설치한다. 현재 버전은 정적·WebView 양쪽에서 첫 0~2장 결과를 미완료로 보고
숨은 스크롤 뒤 다시 수집한다.

### Chrome은 되는데 앱만 403·연결 초기화

VPN 앱별 대상에 Manga Viewer UID가 빠졌을 가능성이 크다. VPN 대상 앱에 Manga Viewer를
추가한다. 서버 403과 이미지 호스트 403은 별개이므로 페이지와 이미지 응답을 각각 본다.

### 수집 중 사이트 스크롤이 보임

APK v1.3의 정상 경로는 네이티브 검은 덮개만 보인다. 로그인이 필요해 사용자가
**로그인 · 페이지 보기**를 누른 경우에만 원본 페이지가 보인다.

### 앱이 검은 화면

iPlay 60 mini Pro에서 ADB `am force-stop` 뒤 Chromium sandbox가 `process is bad`로 고정되는
기기 문제가 재현됐다. 앱 예외가 아니며 재설치·재실행으로 안 풀릴 수 있다. 태블릿 재부팅으로
복구한다. 반복 검증에서는 `am force-stop` 대신 정상 앱 재실행이나 앱 내부 OTA reload를 쓴다.

### 오프라인에서 `undefined` 또는 정적 HTML만 보임

- `undefined`: 예전 저장 레코드에 `pageNumber`가 없던 형식. 읽을 때 원본 page 필드를 합친다.
- 정적 HTML만 표시: 첫 서비스워커 설치 때 Vite 해시 JS/CSS가 빠진 캐시. 현재 서비스워커는
  `index.html`을 읽고 참조된 자산까지 precache한다.

## 핵심 Git 이력

```text
0127051 광고 한 장 수집 성공을 막음
278a9bd 작은 정적 수집 결과는 렌더링 재시도
147e7a8 다음 화를 조용히 미리 수집
77ff5e1 WebView 수집 함수 이름 고정
630cbc3 Android APK와 서명 OTA 업데이트 추가
f3b12d5 오프라인에서만 드러나던 두 가지 수정
d51b762 Cloudflare Worker와 앱을 한 오리진으로 통합
```

현재 전체 이력:

```sh
git log --oneline --decorate
```

## 관련 문서

- [ANDROID.md](ANDROID.md) — APK 설치, OTA, 재빌드 경계
- [DEPLOY.md](DEPLOY.md) — Cloudflare 배포, 인증, 팀 공유
- [TABLET.md](TABLET.md) — Termux 단독 실행 대안
