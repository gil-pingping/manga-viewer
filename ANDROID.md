# Android APK

Cloudflare가 만화 사이트를 대신 호출하지 않는다. APK가 태블릿 네트워크로 HTML과 이미지를
직접 받으므로 데이터센터 IP만 막는 사이트도 대상 사이트가 태블릿을 허용하면 동작한다.

## 설치

빌드 결과:

```
android/app/build/outputs/apk/debug/app-debug.apk
```

파일을 태블릿으로 옮겨 한 번 설치한다. USB 디버깅을 켜고 연결했다면 맥에서 아래 명령으로
바로 설치할 수도 있다.

```sh
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

APK 기능:

- 주소 하나로 화 수집, 이전화·다음화 이동
- 403·로그인·JavaScript 렌더링 페이지는 앱 안 WebView로 자동 전환
- WebView에서 로그인 후 **가져오기**를 누르면 같은 쿠키로 이미지 다운로드
- 한 장·두 장·세로 스크롤, RTL/LTR, 확대·스와이프·자동 넘김
- 10화 연속 담기, IndexedDB 오프라인 서재, CBZ/ZIP·이미지 파일 열기
- 태블릿 VPN 사용 가능: 만화 요청도 태블릿 VPN 경로를 탄다

사이트가 계정, CAPTCHA, 기기 인증, 지역 제한을 요구하면 앱 안 WebView에서 그 절차는 직접
끝내야 한다. 사이트 자체가 Android WebView나 해당 VPN IP를 차단하면 앱이 그 정책까지
깨지는 못한다.

## 맥에서 웹 코드 업데이트

```sh
npm test && npm run deploy
```

기존 Worker 정적 자산과 서명된 OTA ZIP이 같이 배포된다. 태블릿에서 앱을 완전히 닫았다가
다시 열면 새 번들을 확인하고 한 번 재시작한다. APK 재설치와 맥 상시 실행은 필요 없다.
다운로드 실패 시 현재 버전으로 계속 열리고, 새 번들이 부팅에 실패하면 기본 APK로 롤백한다.

첫 설정에서 만든 개인키는 아래 경로에만 있다. 이 파일을 잃으면 기존 APK에 OTA를 보낼 수
없으므로 암호화 백업한다. 저장소에는 공개키만 커밋한다.

```
~/.config/manga-viewer/ota-private.pem
```

새 맥에서는 백업한 키를 같은 경로에 두고 권한을 제한한다.

```sh
chmod 600 ~/.config/manga-viewer/ota-private.pem
```

## 태블릿 화면 원격 진단

USB 디버깅 연결 상태에서 앱 WebView 에 DevTools 프로토콜로 붙는다. Chrome 없이 터미널만으로 된다.

```sh
adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof dev.giyun.mangaviewer)
node scripts/tablet-probe.mjs eval "document.getElementById('ota-tag').textContent"
node scripts/tablet-probe.mjs watch 30      # 콘솔·네트워크 실패 스트리밍
```

앱을 `am force-stop` 으로 죽이고 바로 다시 켜면 이 기기는 WebView 렌더러가 안 붙어 검은 화면이
잦다 (evaluate 무응답). 복구·주의사항은 `scripts/tablet-probe.mjs` 머리말 참고.

## APK를 다시 빌드해야 할 때

Java 플러그인, Capacitor 의존성, AndroidManifest, 권한, 공개키를 바꾼 경우만 해당한다.

```sh
npm run android:build
```

일반 HTML/CSS/JavaScript 수정은 `npm run deploy`만 한다. OTA는 임의 원격 코드를 허용하지
않고, 고정된 Worker 경로의 ZIP만 RSA 서명과 SHA-256으로 검증한다.
