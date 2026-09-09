package dev.giyun.mangaviewer;

import android.app.Dialog;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;
import org.json.JSONArray;
import org.json.JSONTokener;

@CapacitorPlugin(name = "PageCollector")
public class PageCollectorPlugin extends Plugin {

    private static final String TAG = "PageCollector";
    private static final int MAX_SCROLL_TICKS = 30;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private Dialog dialog;
    private WebView webView;
    private TextView statusView;
    private View collectorCover;
    private PluginCall activeCall;
    private String collectorScript;
    private int navigationGeneration;
    private int failedGeneration = -1;
    private long navigationStartedAt;
    private boolean silentCollector;

    @PluginMethod
    public void collect(PluginCall call) {
        String url = call.getString("url");
        String script = call.getString("script");
        if (!isAllowedUrl(url)) {
            call.reject("공개 http/https 주소만 열 수 있습니다.");
            return;
        }
        if (script == null || script.isEmpty() || script.length() > 250_000) {
            call.reject("수집 스크립트가 없거나 너무 큽니다.");
            return;
        }
        if (activeCall != null) {
            call.reject("이미 다른 페이지를 열고 있습니다.");
            return;
        }

        activeCall = call;
        collectorScript = script;
        silentCollector = Boolean.TRUE.equals(call.getBoolean("silent", false));
        getActivity().runOnUiThread(() -> openCollector(url));
    }

    private void openCollector(String url) {
        dialog = new Dialog(getActivity(), android.R.style.Theme_DeviceDefault_NoActionBar_Fullscreen);
        if (silentCollector) {
            webView = new WebView(getContext());
            configureWebView(webView);
            dialog.setContentView(webView);
            dialog.setOnCancelListener((ignored) -> finishError("수집이 중단됐습니다."));
            dialog.show();
            Window window = dialog.getWindow();
            if (window != null) {
                window.clearFlags(WindowManager.LayoutParams.FLAG_DIM_BEHIND);
                window.addFlags(
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE |
                    WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                );
                WindowManager.LayoutParams attributes = window.getAttributes();
                attributes.alpha = 0.01f;
                window.setAttributes(attributes);
            }
            webView.loadUrl(url);
            return;
        }

        FrameLayout root = new FrameLayout(getContext());
        root.setBackgroundColor(Color.rgb(11, 12, 14));

        LinearLayout browser = new LinearLayout(getContext());
        browser.setOrientation(LinearLayout.VERTICAL);

        LinearLayout toolbar = new LinearLayout(getContext());
        toolbar.setOrientation(LinearLayout.HORIZONTAL);
        toolbar.setGravity(android.view.Gravity.CENTER_VERTICAL);
        int padding = dp(8);
        toolbar.setPadding(padding, padding, padding, padding);

        Button collectButton = new Button(getContext());
        collectButton.setText("가져오기");
        collectButton.setOnClickListener(
            (View ignored) -> {
                collectorCover.setVisibility(View.VISIBLE);
                setStatus("이미지 찾는 중…");
                wakeLazyImages(navigationGeneration, 0);
            }
        );
        toolbar.addView(collectButton, new LinearLayout.LayoutParams(0, dp(48), 1));

        Button hideButton = new Button(getContext());
        hideButton.setText("페이지 숨기기");
        hideButton.setOnClickListener((View ignored) -> collectorCover.setVisibility(View.VISIBLE));
        toolbar.addView(hideButton, new LinearLayout.LayoutParams(0, dp(48), 1));

        Button closeButton = new Button(getContext());
        closeButton.setText("취소");
        closeButton.setOnClickListener((View ignored) -> finishError("사용자가 취소했습니다."));
        toolbar.addView(closeButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)));

        webView = new WebView(getContext());
        configureWebView(webView);
        browser.addView(toolbar, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        browser.addView(webView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        root.addView(browser, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        LinearLayout cover = new LinearLayout(getContext());
        cover.setOrientation(LinearLayout.VERTICAL);
        cover.setGravity(android.view.Gravity.CENTER);
        cover.setPadding(dp(24), dp(24), dp(24), dp(24));
        cover.setBackgroundColor(Color.rgb(11, 12, 14));
        collectorCover = cover;

        statusView = new TextView(getContext());
        statusView.setText("페이지 여는 중…");
        statusView.setTextColor(Color.WHITE);
        statusView.setTextSize(18);
        statusView.setGravity(android.view.Gravity.CENTER);
        cover.addView(statusView, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button showButton = new Button(getContext());
        showButton.setText("로그인 · 페이지 보기");
        showButton.setOnClickListener((View ignored) -> collectorCover.setVisibility(View.GONE));
        LinearLayout.LayoutParams showParams = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(52));
        showParams.topMargin = dp(20);
        cover.addView(showButton, showParams);

        Button coverCloseButton = new Button(getContext());
        coverCloseButton.setText("취소");
        coverCloseButton.setOnClickListener((View ignored) -> finishError("사용자가 취소했습니다."));
        cover.addView(coverCloseButton, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(52)));
        root.addView(cover, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        dialog.setContentView(root);
        dialog.setOnCancelListener((ignored) -> finishError("사용자가 취소했습니다."));
        dialog.show();
        webView.loadUrl(url);
    }

    private void configureWebView(WebView view) {
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setSupportMultipleWindows(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) settings.setSafeBrowsingEnabled(true);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(view, false);

        view.setWebChromeClient(new WebChromeClient());
        view.setWebViewClient(
            new WebViewClient() {
                @Override
                public void onPageStarted(WebView current, String url, android.graphics.Bitmap favicon) {
                    navigationGeneration++;
                    navigationStartedAt = SystemClock.elapsedRealtime();
                    failedGeneration = -1;
                    setStatus("페이지 여는 중…");
                }

                @Override
                public void onPageFinished(WebView current, String url) {
                    int generation = navigationGeneration;
                    if (generation == failedGeneration) return;
                    setStatus("이미지 찾는 중…");
                    handler.postDelayed(() -> evaluateCollector(generation, true), 300);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView current, WebResourceRequest request) {
                    return !isAllowedUrl(request.getUrl().toString());
                }

                @Override
                public void onReceivedError(WebView current, WebResourceRequest request, WebResourceError error) {
                    if (request.isForMainFrame()) {
                        failedGeneration = navigationGeneration;
                        if (silentCollector) {
                            finishError("페이지를 열지 못했습니다.");
                            return;
                        }
                        setStatus("페이지 오류 · 로그인하거나 주소를 확인하세요");
                    }
                }

                @Override
                public void onReceivedHttpError(
                    WebView current,
                    WebResourceRequest request,
                    WebResourceResponse response
                ) {
                    if (request.isForMainFrame()) {
                        failedGeneration = navigationGeneration;
                        if (silentCollector) {
                            finishError("사이트 응답 " + response.getStatusCode());
                            return;
                        }
                        setStatus("사이트 응답 " + response.getStatusCode());
                    }
                }
            }
        );
    }

    /** lazy 이미지를 깨운 뒤 현재 DOM에서 기존 공용 선별 규칙을 실행한다. */
    private void wakeLazyImages(int generation, int tick) {
        if (!isActive(generation)) return;
        if (tick >= MAX_SCROLL_TICKS) {
            finishScrollAndCollect(generation);
            return;
        }

        String script =
            "(function(){" +
            "var b=document.body,d=document.documentElement;" +
            "var h=Math.max(b?b.scrollHeight:0,d?d.scrollHeight:0);" +
            "var step=Math.max(window.innerHeight,600);" +
            "window.scrollTo(0,Math.min(window.scrollY+step,h));" +
            "return [Math.round(window.scrollY),h,window.innerHeight].join(',');" +
            "})()";
        webView.evaluateJavascript(
            script,
            value -> {
                if (!isActive(generation)) return;
                try {
                    String state = String.valueOf(new JSONTokener(value).nextValue());
                    String[] parts = state.split(",");
                    long y = Long.parseLong(parts[0]);
                    long height = Long.parseLong(parts[1]);
                    long viewport = Long.parseLong(parts[2]);
                    if (y + viewport >= height - 8) {
                        finishScrollAndCollect(generation);
                        return;
                    }
                } catch (Exception ignored) {
                    // DOM이 바뀌는 중이면 제한 횟수까지 다시 훑는다.
                }
                handler.postDelayed(() -> wakeLazyImages(generation, tick + 1), 100);
            }
        );
    }

    private void finishScrollAndCollect(int generation) {
        if (!isActive(generation)) return;
        webView.evaluateJavascript("window.scrollTo(0,0)", null);
        handler.postDelayed(() -> evaluateCollector(generation, false), 250);
    }

    private void evaluateCollector(int generation, boolean scrollOnEmpty) {
        if (!isActive(generation)) return;
        webView.evaluateJavascript(
            collectorScript,
            value -> {
                if (!isActive(generation)) return;
                try {
                    Object decoded = new JSONTokener(value).nextValue();
                    if (!(decoded instanceof String)) throw new IllegalStateException("수집 결과가 문자열이 아닙니다.");
                    JSObject result = new JSObject((String) decoded);
                    String collectorError = result.optString("collectorError", "");
                    if (!collectorError.isEmpty()) {
                        Log.e(TAG, collectorError);
                        if (silentCollector) {
                            finishError(shortMessage(collectorError));
                            return;
                        }
                        setStatus("수집 실패 · " + shortMessage(collectorError));
                        return;
                    }
                    JSONArray pages = result.optJSONArray("pages");
                    int pageCount = pages == null ? 0 : pages.length();
                    if (shouldScrollBeforeAccepting(pageCount, scrollOnEmpty)) {
                        setStatus("lazy 이미지 확인 중…");
                        wakeLazyImages(generation, 0);
                        return;
                    }
                    if (result.optBoolean("pending", false) &&
                        SystemClock.elapsedRealtime() - navigationStartedAt < 20_000) {
                        setStatus("만화 본문 불러오는 중…");
                        handler.postDelayed(() -> evaluateCollector(generation, false), 500);
                        return;
                    }
                    if (pageCount == 0) {
                        if (silentCollector) {
                            finishError("이미지를 찾지 못했습니다.");
                            return;
                        }
                        setStatus("이미지 없음 · 로그인 후 ‘가져오기’를 누르세요");
                        return;
                    }
                    finishSuccess(result);
                } catch (Exception err) {
                    Log.e(TAG, "수집 결과를 읽지 못했습니다.", err);
                    if (silentCollector) {
                        finishError("수집 결과를 읽지 못했습니다.");
                        return;
                    }
                    setStatus("수집 실패 · 페이지를 확인하고 다시 누르세요");
                }
            }
        );
    }

    private boolean isActive(int generation) {
        return activeCall != null && webView != null && generation == navigationGeneration;
    }

    static boolean shouldScrollBeforeAccepting(int pageCount, boolean firstPass) {
        return firstPass && pageCount < 3;
    }

    private void setStatus(String text) {
        if (statusView != null) statusView.setText(text);
    }

    private String shortMessage(String message) {
        String firstLine = message.split("\\R", 2)[0];
        return firstLine.length() > 90 ? firstLine.substring(0, 90) : firstLine;
    }

    private void finishSuccess(JSObject result) {
        PluginCall call = activeCall;
        closeCollector();
        if (call != null) call.resolve(result);
    }

    private void finishError(String message) {
        PluginCall call = activeCall;
        closeCollector();
        if (call != null) call.reject(message);
    }

    private void closeCollector() {
        navigationGeneration++;
        activeCall = null;
        collectorScript = null;
        if (dialog != null) {
            dialog.setOnCancelListener(null);
            dialog.dismiss();
            dialog = null;
        }
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl("about:blank");
            webView.destroy();
            webView = null;
        }
        statusView = null;
        collectorCover = null;
        silentCollector = false;
    }

    private boolean isAllowedUrl(String raw) {
        if (raw == null) return false;
        Uri uri = Uri.parse(raw);
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || !(scheme.equals("https") || scheme.equals("http"))) return false;

        host = host.toLowerCase(Locale.ROOT).replaceAll("\\.$", "");
        return !(host.equals("localhost") ||
            host.endsWith(".localhost") ||
            host.endsWith(".internal") ||
            host.equals("::1") ||
            host.equals("0.0.0.0") ||
            host.startsWith("127.") ||
            host.startsWith("10.") ||
            host.startsWith("192.168.") ||
            host.startsWith("169.254.") ||
            host.matches("172\\.(1[6-9]|2\\d|3[01])\\..*") ||
            host.matches("f[cd][0-9a-f]{2}:.*") ||
            host.startsWith("fe80:"));
    }

    private int dp(int value) {
        return Math.round(value * getContext().getResources().getDisplayMetrics().density);
    }

    @Override
    protected void handleOnDestroy() {
        if (activeCall != null) finishError("앱이 종료되어 페이지 수집을 중단했습니다.");
        super.handleOnDestroy();
    }
}
