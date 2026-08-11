# Manga Viewer 안정화·데이터 보존 계획

작성일: 2026-08-11  
기준 커밋: `277cdbd` (`v1.3.7-STABLE`)  
GitHub: `https://github.com/gil-pingping/manga-viewer` (private)

## 결론

- 로컬 Git 이력 최고 버전은 `1.5.3`이다. `1.5.7` 커밋·태그·reflog는 없다.
- `1.5.x` 전체 cherry-pick 금지. 깨진 통합 코드가 많아 필요한 동작만 다시 작성한다.
- 첫 복구 릴리스는 `1.3.8`: 데이터 보존, 현재 뷰어 회귀 수정만 포함한다.
- 애니 기능은 `1.3.8`에서 제외한다. 별도 검증 후 `1.6.0` 후보로 다룬다.
- 태블릿 데이터 백업·건수 확인 전 OTA/APK 배포 금지.

## 확인된 상태

| 항목 | 결과 |
|---|---|
| 현재 HEAD | `277cdbd`, `v1.3.7-STABLE` |
| GitHub main | 로컬 HEAD와 동일 |
| 이후 이력 | `1ba944c` 1.3.7 → `bd1afb6` 1.5.0 → `91cbe34` 1.5.2 → `e511703` 1.5.3 → `277cdbd` 롤백 |
| 현재 작업트리 | Gemini 추정 미커밋 변경 10개 + 신규 파일 2개 |
| 현재 JS 테스트 | 통과 |
| 현재 Vite 빌드 | 통과, 실제 브라우저·Android 통합 검증 없음 |
| 태블릿 | 2026-08-11 현재 ADB 미연결 |

## root cause

### 데이터 유실

일반 회차 목록은 영구 서재가 아니다.

- `src/state.js`: `.slice(0, 30)`으로 localStorage에 최대 30화만 저장한다.
- localStorage 용량 초과 시 10화로 줄이고, 다시 실패하면 키를 삭제한다.
- `src/library.js`: IndexedDB `recent_chapters`도 30화만 남기고 매번 `clear()` 후 재작성한다.
- 업데이트/reload는 새 데이터 손실 원인이 아니라, 메모리에만 있던 목록이 사라져 이 제한을 드러내는 계기다.
- 사용자가 명시적으로 `담기`한 화만 기존 IndexedDB `chapters/pages`에 제한 없이 남는다.

정상 OTA는 번들 경로만 바꾸고 같은 `https://localhost`를 다시 로드한다. IndexedDB 삭제 코드는 없다. APK 삭제 후 재설치, 앱 데이터 삭제, 다른 서명키, 다른 origin은 별도 전손 경로다.

이미 재시작돼 30화로 잘린 메타데이터는 코드만으로 복구 못 한다. 태블릿 WebView DB, 실행 중 메모리, 별도 백업에 남아 있어야 복구 가능하다.

### `1.5.x` 파손

- `main.js`가 존재하지 않는 `fetched.rawText`를 읽어 애니 파서를 호출하지 못한다.
- 실패 폴백은 애니 웹페이지 URL을 `<video src>`에 넣는다. 영상 URL이 아니다.
- 애니 레코드를 `state.chapters`나 IndexedDB에 저장하지 않아 애니 서재는 항상 비어 있다.
- 저장 직렬화가 애니 필드를 버리고, 복원은 `pages.length === 0` 레코드를 버린다.
- `referer` 스코프 오류로 서재 카드 렌더가 `ReferenceError`를 낸다.
- 표지 새로고침은 새 group 객체에서 사라진 함수를 찾아 성공 토스트만 띄운다.
- ED 구간 `timeupdate`마다 다음화를 중복 호출한다.
- 실제 타임스탬프가 없어도 85~175초를 OP로 가정해 콘텐츠를 잘못 건너뛴다.
- `hostname.includes('anilife.app')`는 유사 악성 도메인을 허용한다.
- 플레이어 테스트는 실제 클래스를 import하지 않고 조건문을 복사해 검사한다.
- `277cdbd` 롤백 뒤 애니 모듈·테스트·`currentShelfTab`이 고아 코드로 남았다.

### 현재 미커밋 변경 위험

- charset 테스트는 Node에서 통과하지만 Android 경로는 `responseType: 'text'`로 이미 디코딩된 문자열을 바이트로 역변환한다. 원본 EUC-KR 바이트 보존이 보장되지 않는다.
- Capacitor Android의 `responseType: 'arraybuffer'` 결과는 base64 문자열이다. 이 경로로 받아 디코딩해야 한다.
- 시리즈 파서는 렌더 중 chapter 객체를 직접 수정하고, 제목의 임의 숫자를 회차로 추정한다. 연도·작품 ID 오분류 위험이 있다.
- `seriesKeyFromUrl`, `seriesNameFromTitle` 등 중복/고아 로직이 남아 있다.
- `git diff --check`가 EOF 공백 3건을 보고한다.

## Phase 0 — 허용 API·기존 패턴 고정

### 사용 가능

- IndexedDB 래퍼 패턴: `src/library.js:26-69`
- 기존 이미지 서재 API: `listChapters`, `saveChapter`, `deleteChapter`, `resolveOffline`
- 기존 부팅 병합 위치: `main.js:1551-1582`
- 기존 저장 호출 위치: `main.js:243-245`, `271-290`, `308-315`, `1437-1452`
- StorageManager: `navigator.storage.persist()`, `navigator.storage.estimate()`
- Capacitor HTTP 8.5.0: `responseType: 'arraybuffer' | 'blob' | 'json' | 'text' | 'document'`
- Android `arraybuffer/blob` 응답: base64 문자열
- Live Update 8.3.0: `ready`, `getCurrentBundle`, `getNextBundle`, `getDownloadedBundles`, `downloadBundle`, `setNextBundle`, `reload`, `clearBlockedBundles`
- 브라우저 기본 API: `Blob`, object URL, `<a download>`, file input, `JSON.parse/stringify`

### 금지

- 존재하지 않는 `UrlHarvester.fetchFromUrl(...).rawText`
- `recent_chapters.clear()` 뒤 전체 스냅숏 교체
- 기존 `mangaViewer` DB를 v3로 올리기
- unload 이벤트에서 시작한 비동기 저장을 완료됐다고 가정하기
- 새 저장 라이브러리·상태관리 프레임워크 추가
- `1.5.x` 커밋 전체 cherry-pick

## Phase 1 — 배포 전 원본 데이터 구조

### 구현/작업

1. 태블릿 연결 전 현재 앱 종료·업데이트·삭제 금지.
2. ADB 연결 후 package/version/signing/origin 기록.
3. 가능하면 `run-as dev.giyun.mangaviewer`로 `app_webview` 원본을 읽기 전용 복사한다.
4. Chrome WebView 디버깅에서 아래 건수를 기록한다.
   - localStorage 5개 키
   - IndexedDB `chapters`, `pages`, `recent_chapters`
   - 작품 수, 회차 수, progress 키 수
5. 백업 파일 SHA-256과 건수 manifest를 함께 저장한다.
6. 현재 미커밋 변경은 `recovery/gemini-wip-20260811` 보관 커밋으로 격리한다. 안정화 브랜치는 `277cdbd`에서 시작한다.

### 검증

- 원본 백업 파일이 0바이트가 아니다.
- 백업 hash를 다시 계산해 동일하다.
- 기록된 회차 수와 현재 UI 수가 맞는다.
- 백업 복사 뒤 앱 데이터가 그대로 열린다.

### 금지

- `adb uninstall`, `pm clear`, Android 설정의 데이터 삭제
- 다른 debug keystore APK 설치
- 백업 확인 전 OTA manifest 교체

## Phase 2 — 전체 카탈로그를 영구 저장

### 구현

새 파일 `src/catalogStore.js`에 별도 IndexedDB를 만든다.

```text
DB: mangaViewerState
version: 1
stores:
  catalog  keyPath=id
  kv       keyPath=key
```

기존 `mangaViewer` DB v2와 `chapters/pages`는 손대지 않는다. 이유: 새 코드가 기존 DB를 v3로 올리면 1.3.7 롤백이 v2 open에서 `VersionError`를 낼 수 있다.

`catalog` 레코드 최소 필드:

```text
id, kind, title, label, pages, coverUrl,
sourceUrl, prevUrl, nextUrl, savedAt, updatedAt
```

`kv` 최소 키:

```text
settings, progress, lastChapterId, initialized, migration.v1
```

저장 정책:

- 새 회차/갱신: 해당 레코드 `put`.
- progress/settings/last ID: 해당 `kv`만 `put`.
- 삭제: 사용자 명시 삭제 때 해당 ID만 `delete`.
- 자동 개수 제한 없음.
- 전체 store `clear()` 없음.
- localStorage 최근 30개는 빠른 캐시로만 유지. 복구 원본 아님.

### 문서 참조

- transaction wrapper: `src/library.js:26-69`
- 현재 chapter shape: `src/state.js:1-28`
- upsert 호출: `main.js:271-315`
- 명시 삭제: `main.js:795-818`, `888-895`, `963-976`

### 검증

- 31화와 1001화를 저장하고 reload 뒤 같은 개수.
- 같은 source URL 재수집 시 중복 증가 없음.
- 한 화 삭제 시 다른 화와 공유하는 page blob 유지.
- localStorage를 지워도 catalog/progress/settings 복원.
- 쓰기 실패 시 기존 catalog 건수 감소 없음.

### 금지

- 숫자 `30`을 `1000`으로 바꾸는 임시 수정
- `state.chapters` 전체를 매번 재작성
- 저장 오류를 빈 배열로 바꾸고 샘플 데이터를 덮어쓰기

## Phase 3 — 무손실 마이그레이션·부팅·OTA 연결

### 구현

첫 부팅 때 다음 원본을 합쳐 새 `catalog`에 넣는다.

1. 기존 `mangaViewer.chapters`
2. 기존 `mangaViewer.recent_chapters`
3. localStorage `mangaViewer.recentChapters`

병합 기준:

- 같은 `id` 우선.
- ID가 달라도 같은 정규화 `sourceUrl`이면 최신 필드를 병합.
- pages/cover/source/prev/next의 기존 비어 있지 않은 값 보존.
- 모든 `put` 성공 뒤에만 `migration.v1=complete` 기록.
- 기존 DB와 localStorage 삭제 금지.

부팅 정책:

- 새 catalog를 먼저 읽고 메모리 목록 구성.
- 저장소 read 실패 시 읽기 전용 오류 화면. 샘플 데이터 자동 저장 금지.
- `confirmBundleReady()` 완료 후 앱 부팅, 저장 flush 완료 후 `reload()`.
- `capacitor.config.json`에 기존 기본 origin을 명시한다.

```json
"server": {
  "hostname": "localhost",
  "androidScheme": "https"
}
```

### 검증

- v2 데이터로 시작해 migration 뒤 모든 건수 동일.
- migration 도중 강제 종료 후 재실행해 중복·삭제 없음.
- 정상 OTA, rollback, 재업데이트 각각 전후 건수 동일.
- 앱 URL이 모든 OTA 번들에서 `https://localhost`.

### 금지

- migration 시작 전에 원본 삭제
- migration 완료 flag 선기록
- 부팅 read 실패를 `[]`로 숨기기

## Phase 4 — 사용자 JSON 백업·복원

### 구현

새 의존성 없이 메타데이터 백업을 추가한다.

포함:

- schemaVersion, exportedAt, appVersion
- catalog 전체
- progress, settings, lastChapterId
- origin/appId 진단값

제외:

- 이미지 Blob. GB 단위 파일과 WebView OOM 위험 때문에 첫 릴리스에서 제외.

import 정책:

- JSON schema·타입·크기 검증.
- 미리보기에서 작품/회차/progress 건수 표시.
- 기존 데이터와 merge. replace/clear 없음.
- 충돌 시 sourceUrl/id가 같은 레코드의 비어 있지 않은 최신 필드 보존.

### 검증

- 1001화 export → 새 브라우저 profile import → 건수·진행도 동일.
- 손상 JSON, 다른 schema, 과대 파일 거부.
- import 실패 뒤 기존 건수 동일.

## Phase 5 — 현재 미커밋 수집 수정 선별

각 변경을 독립 커밋으로 처리한다.

1. `num` 회차 파라미터 우선과 nav 메타 탐색
   - 실제 HTML fixture로 previous/next URL 검증.
   - collector, native collector, URL harvester가 같은 판단 함수를 쓰게 중복 제거.
2. EUC-KR/CP949
   - Worker/Node는 `Response.arrayBuffer()` 후 decoder 사용.
   - Android는 `responseType: 'arraybuffer'` base64를 실제 bytes로 변환 후 decoder 사용.
   - `responseType: 'text'` 역변환 코드 폐기.
3. 시리즈 정규화
   - 순수 함수만 사용. 렌더 중 chapter mutation 금지.
   - 임의 숫자 fallback 제거 또는 사이트별 명시 규칙으로 제한.
   - 연도·작품 ID·다중 query parameter 오분류 fixture 추가.
4. 고아 함수·EOF 공백 삭제.

### 검증

- Node fixture뿐 아니라 Worker local runtime와 Android 실기기에서 같은 한글 제목.
- `toon=작품ID&num=회차`에서 `toon` 유지, `num`만 증감.
- 서로 다른 작품이 같은 `/cv` 경로 때문에 합쳐지지 않음.
- 기존 네이버/Pinterest/mocksite 결과 변화 없음.

## Phase 6 — `1.5.x` 기능은 별도 재작성

`1.3.8` 출시 뒤 진행한다.

### 먼저 제거

안정 브랜치에서 사용되지 않는 아래 파일/필드를 제거한다. Git 이력에 원본이 남아 있다.

- `src/collect/anilifeCollector.js`
- `src/ui/animePlayer.js`
- 관련 두 테스트
- `currentShelfTab`

### 다시 만들 조건

- 페이지 HTML은 지원되는 `fetchPageDocument()` 경로로 받는다.
- 허용 host는 정확한 host/subdomain 비교.
- stream/embed URL은 scheme·host allowlist 검증.
- 웹페이지 URL을 video URL로 폴백하지 않음.
- 애니를 공통 catalog 레코드로 먼저 저장한 뒤 탭 UI 연결.
- `pages` 없는 media 레코드를 type-aware 복원.
- 실제 OP/ED timestamp가 있을 때만 자동 스킵.
- 다음화 전환에 single-flight guard.
- Android WebView에서 실제 재생 가능한 포맷 확인 전 HLS 라이브러리 추가 금지.

### 검증

- parser fixture가 실제 응답 구조와 일치.
- import → 저장 → 재시작 → 재생 통합 테스트.
- ED 구간에서 다음화 호출 정확히 1회.
- 유사 악성 host, javascript/data URL 거부.
- 실제 `AnimePlayer` 클래스를 테스트.

## Phase 7 — 릴리스 게이트

### 자동 검사

```sh
npm test
npm run build
npm run android:build
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew :app:testDebugUnitTest
```

`predeploy`에 `npm test`를 연결해 테스트 실패 배포를 막는다. GitHub Actions는 지금 추가하지 않는다. 단일 사용자·실기기 검증이 우선이다.

### 데이터 보존 매트릭스

| 경로 | 준비 | 기대 결과 |
|---|---|---|
| 브라우저 reload | 1001화 + progress | 건수·진행도 동일 |
| localStorage 삭제 | catalog 유지 | 전체 목록·진행도 복원 |
| OTA 1.3.7 → 1.3.8 | 백업·건수 기록 | 전후 동일 |
| 깨진 OTA rollback | 1.3.8 state 존재 | 구버전은 기존 DB로 부팅, 재업데이트 후 전체 복원 |
| `adb install -r` | 동일 appId/서명키 | 전후 동일 |
| 앱 삭제 후 설치 | JSON 백업 | import 후 메타·진행도 복원 |
| Cloudflare/Termux/APK | 각 origin | origin별 데이터가 섞이지 않음 |

### 출시 순서

1. 태블릿 원본 백업.
2. `1.3.8-rc1` 로컬/브라우저 1001화 테스트.
3. 한 태블릿에 OTA canary.
4. 업데이트 전후 manifest 비교.
5. 실패 시 manifest를 이전 bundle로 되돌림. APK 삭제 금지.
6. 통과 뒤 `v1.3.8` tag와 release 생성.

버전 동기화 대상:

- `package.json`
- `src/version.js`
- `android/app/build.gradle`의 `versionCode/versionName`
- `src/core/otaManifest.js`의 `NATIVE_VERSION`은 네이티브 호환성이 바뀔 때만 증가
- `README.md` 배포 정보

## 완료 기준

- 원피스 1000화 이상 목록이 reload·OTA·in-place APK update 뒤 그대로 남는다.
- progress/settings/last chapter도 복원된다.
- 데이터 삭제는 사용자 명시 삭제에서만 일어난다.
- 백업 export/import로 앱 삭제 후 메타데이터를 복구할 수 있다.
- `1.5.x` 고아 코드가 안정판 실행 경로에 없다.
- 모든 자동 검사와 Android 실기기 보존 매트릭스 통과.

## 범위 밖

- 이미지 Blob 전체 ZIP 백업
- 클라우드 동기화
- 애니 기능의 `1.3.8` 포함
- 다중 사용자/계정 시스템
- GitHub Actions 구축

