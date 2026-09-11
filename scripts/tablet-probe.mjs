/**
 * 태블릿 WebView 원격 진단 (Chrome DevTools Protocol, 의존성 없음 — node 22+ 내장 WebSocket).
 *
 *   adb forward tcp:9222 localabstract:webview_devtools_remote_$(adb shell pidof dev.giyun.mangaviewer)
 *   node scripts/tablet-probe.mjs eval "document.getElementById('page-indicator').textContent"
 *   node scripts/tablet-probe.mjs watch 30 [inject.js]        # 콘솔·네트워크 실패 30초 스트리밍 (선택: 주입 스크립트)
 *   node scripts/tablet-probe.mjs reload
 *   node scripts/tablet-probe.mjs reloadpoll 20 2 "<expr>"    # 새로고침 뒤 2초마다 expr 평가
 *   CDP_TIMEOUT=15000 …                                        # 무응답 감시 (기본 15초)
 *
 * 2026-09-10 실측 메모: 이 기기는 `am force-stop` 직후 재실행하면 WebView 렌더러가 안 붙어
 * 검은 화면(evaluate 무응답)이 잦다. `am force-stop com.google.android.webview` 는 하지 말 것 —
 * 그 뒤 재실행마다 렌더러가 죽었다. 복구 실측: WebView DevTools 액티비티를 한 번 띄운다
 *   adb shell am start -n com.google.android.webview/org.chromium.android_webview.devui.MainActivity
 * 그리고 앱을 다시 실행. 그래도 안 뜨면 태블릿 재부팅.
 */
setTimeout(() => { console.error('[cdp] watchdog timeout — renderer unresponsive'); process.exit(2); }, Number(process.env.CDP_TIMEOUT || 15000)).unref();
const [, , cmd, arg1, arg2] = process.argv;
const pages = await (await fetch('http://localhost:9222/json')).json();
const page = pages.find((p) => p.type === 'page' && !/devtools/.test(p.url)) || pages[0];
if (!page) { console.error('no page'); process.exit(1); }
console.error('[page]', page.url);
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
const send = (method, params = {}) => new Promise((res, rej) => {
  const mid = ++id;
  pending.set(mid, { res, rej });
  ws.send(JSON.stringify({ id: mid, method, params }));
});
await new Promise((r) => (ws.onopen = r));
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { res, rej } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? rej(new Error(JSON.stringify(msg.error))) : res(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled') {
    if (cmd === 'eval') return;
    const { type, args, timestamp } = msg.params;
    const first = args[0]?.value ?? '';
    const m = typeof first === 'string' && first.match(/(native|result) %cCapacitorHttp\.get \(#(\d+)\)/);
    if (m) { pendingHttp = { kind: m[1], id: m[2] }; return; }
    if (type === 'log' && typeof first === 'string' && first.startsWith('[httpdir]') && pendingHttp) {
      let props = {}; try { props = JSON.parse(args[1]?.value || first.slice(9)); } catch {}
      if (pendingHttp.kind === 'native') httpStart.set(pendingHttp.id, { t: timestamp, url: props.url || '' });
      else { const s = httpStart.get(pendingHttp.id); const u = s?.url || ''; const host = u.replace(/^https?:\/\//, '').split(/[/?]/)[0]; console.log(`[http] ${s ? Math.round(timestamp - s.t) : '?'}ms status=${props.status} ${u.includes('proxy-image') ? 'PROXY' : 'DIRECT'} ${host} ${props.error || ''}`); httpStart.delete(pendingHttp.id); }
      pendingHttp = null; return;
    }
    if (type === 'dir') return;
    if (type === 'endGroup' || type === 'startGroupCollapsed') return;
    const objs = args.filter((a) => a.objectId && a.type === 'object');
    const text = args.map((a) => a.value ?? a.description ?? JSON.stringify(a)).join(' ');
    if (objs.length && (type === 'error' || type === 'warning')) {
      Promise.all(objs.map((a) => send('Runtime.callFunctionOn', { objectId: a.objectId, returnByValue: true, functionDeclaration: 'function(){ try { return JSON.stringify(this, Object.getOwnPropertyNames(this)).slice(0, 500); } catch (e) { return String(this); } }' }).then((r) => r.result.value).catch((e) => 'ERR ' + e.message)))
        .then((vals) => console.log(`[console.${type}] ${text.slice(0, 200)} :: ${vals.join(' | ')}`));
      return;
    }
    console.log(`[console.${type}] ${text.slice(0, 400)}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    console.log('[exception]', msg.params.exceptionDetails.text, msg.params.exceptionDetails.exception?.description);
  } else if (msg.method === 'Network.loadingFailed') {
    console.log('[net.fail]', msg.params.type, msg.params.errorText, urls.get(msg.params.requestId) || msg.params.requestId);
  } else if (msg.method === 'Network.requestWillBeSent') {
    urls.set(msg.params.requestId, msg.params.request.url);
  } else if (msg.method === 'Network.responseReceived') {
    const r = msg.params.response;
    if (r.status >= 400) console.log('[net.http]', r.status, r.url);
  }
};
const urls = new Map();
let pendingHttp = null;
const httpStart = new Map();
if (cmd !== 'eval') await send('Runtime.enable');
if (cmd === 'eval') {
  const r = await send('Runtime.evaluate', { expression: arg1, awaitPromise: true, returnByValue: true });
  console.log(r.exceptionDetails ? 'EXC ' + JSON.stringify(r.exceptionDetails) : JSON.stringify(r.result.value, null, 1));
  ws.close(); process.exit(0);
}
if (cmd === 'watch') {
  await send('Network.enable');
  if (arg2) {
    const fs = await import('node:fs');
    const r = await send('Runtime.evaluate', { expression: fs.readFileSync(arg2, 'utf8'), returnByValue: true });
    if (r.exceptionDetails) console.log('inject EXC', JSON.stringify(r.exceptionDetails));
  }
  console.error(`[watching ${arg1}s]`);
  setTimeout(() => { ws.close(); process.exit(0); }, Number(arg1) * 1000);
}
if (cmd === 'reload') {
  await send('Page.enable');
  await send('Page.reload', { ignoreCache: false });
  setTimeout(() => { ws.close(); process.exit(0); }, 500);
}
if (cmd === 'reloadpoll') {
  // reloadpoll <totalSec> <intervalSec> "<expr>"
  const total = Number(arg1), every = Number(arg2), expr = process.argv[5];
  await send('Page.enable');
  const t0 = Date.now();
  await send('Page.reload', { ignoreCache: false });
  const tick = async () => {
    try {
      const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
      console.log(`[t+${((Date.now() - t0) / 1000).toFixed(1)}s]`, r.exceptionDetails ? 'EXC ' + r.exceptionDetails.text : JSON.stringify(r.result.value));
    } catch (e) { console.log('[tick err]', e.message); }
    if (Date.now() - t0 < total * 1000) setTimeout(tick, every * 1000);
    else { ws.close(); process.exit(0); }
  };
  setTimeout(tick, every * 1000);
}
