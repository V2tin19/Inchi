package com.cairn.app;

import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

/**
 * 理序 · Cairn 手机壳：一个 WebView，指向你自己的服务器。
 *
 * 三帧结构（FrameLayout 叠放，任何时刻至少一帧可见，绝不出现纯背景）：
 *   errorBox —— 崩溃栈 / 连不上服务器（重试 / 换地址 / 继续启动）
 *   setupBox —— 首次启动的服务器地址设置
 *   web      —— 正式界面
 *
 * 崩溃留痕：任何未捕获异常写进偏好，下次启动错误页最先亮出来。
 * WebView 懒创建：只有真正要上网时才 new——系统 WebView 坏了也不挡住设置与排障页。
 */
public class MainActivity extends Activity {

    private static final String PREFS = "cairn";
    private static final String KEY_SERVER = "server";
    private static final String KEY_CRASH = "last_crash";
    /** 预填的默认地址（构建时可改），设置页里随时可改 */
    private static final String DEFAULT_SERVER = "http://10.161.204.101:8792";

    private FrameLayout root;
    private LinearLayout errorBox;
    private LinearLayout setupBox;
    private TextView crashView;
    private TextView errMsg;
    private Button retryBtn;
    private WebView web;
    private String serverUrl;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        /* 崩溃留痕：任何未捕获异常写进偏好，下次启动错误页最先亮出来 */
        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler((thread, e) -> {
            try {
                java.io.StringWriter sw = new java.io.StringWriter();
                e.printStackTrace(new java.io.PrintWriter(sw));
                String stack = sw.toString();
                getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                        .putString(KEY_CRASH, stack.length() > 1800 ? stack.substring(0, 1800) : stack)
                        .apply();
            } catch (Throwable ignore) { }
            if (prev != null) prev.uncaughtException(thread, e);
        });

        super.onCreate(savedInstanceState);

        root = new FrameLayout(this);
        setContentView(root);

        /* 帧顺序：web 在最底，setup 中，error 最上。先建不依赖 WebView 的两帧。 */
        errorBox = buildErrorBox();
        root.addView(errorBox, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        setupBox = buildSetupBox();
        root.addView(setupBox, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        serverUrl = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_SERVER, "");
        String crash = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_CRASH, "");

        if (crash.length() > 0) {
            /* 上次崩过：崩溃栈优先亮出来（此时还没碰 WebView，这条路永远走得到） */
            showFrame(errorBox);
            retryBtn.setVisibility(View.GONE);
            Button go = new Button(this);
            go.setText("继续启动 ▸");
            go.setTextColor(Color.parseColor("#A3BE8C"));
            go.setGravity(Gravity.CENTER);
            go.setOnClickListener(v -> {
                if (serverUrl.length() == 0) showFrame(setupBox);
                else initWebAndLoad();
            });
            errorBox.addView(go, 0, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            return;
        }
        if (serverUrl.length() == 0) {
            showFrame(setupBox);
            return;
        }
        initWebAndLoad();
    }

    /* ---------- 帧切换：任何时刻恰好一帧可见 ---------- */
    private void showFrame(View v) {
        errorBox.setVisibility(v == errorBox ? View.VISIBLE : View.GONE);
        setupBox.setVisibility(v == setupBox ? View.VISIBLE : View.GONE);
        if (web != null) web.setVisibility(v == web ? View.VISIBLE : View.GONE);
    }

    /* ---------- WebView 懒创建：设置完成或重试时才碰它 ---------- */
    private void initWebAndLoad() {
        if (web == null) {
            web = new WebView(this);
            WebSettings s = web.getSettings();
            s.setJavaScriptEnabled(true);
            s.setDomStorageEnabled(true);
            s.setDatabaseEnabled(true);
            s.setMediaPlaybackRequiresUserGesture(false);
            s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);   // 局域网 http 不拦
            s.setCacheMode(WebSettings.LOAD_DEFAULT);
            web.setBackgroundColor(Color.parseColor("#1E222A"));
            web.setWebViewClient(new CairnClient());
            root.addView(web, 0, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        }
        showFrame(web);
        web.loadUrl(serverUrl);
    }

    /* ---------- 帧一：首次启动的服务器设置 ---------- */
    private LinearLayout buildSetupBox() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(22), dp(30), dp(22), dp(10));
        box.setBackgroundColor(Color.parseColor("#282C34"));

        TextView title = new TextView(this);
        title.setText("理序 · 连接你的服务器");
        title.setTextColor(Color.parseColor("#E5E9F0"));
        title.setTextSize(19);
        title.setPadding(0, 0, 0, dp(8));
        box.addView(title);

        TextView hint = new TextView(this);
        hint.setText("填电脑上理序服务的地址，手机和电脑连同一个 Wi-Fi 即可。启动服务的终端里会打印这个地址。");
        hint.setTextColor(Color.parseColor("#8792A3"));
        hint.setTextSize(13);
        hint.setPadding(0, 0, 0, dp(14));
        box.addView(hint);

        final EditText input = new EditText(this);
        input.setId(101);
        input.setText(DEFAULT_SERVER);
        input.setTextColor(Color.parseColor("#E5E9F0"));
        input.setHintTextColor(Color.parseColor("#5C6675"));
        input.setHint("http://192.168.x.x:8792");
        input.setSingleLine(true);
        input.setTextSize(14);
        box.addView(input);

        Button ok = new Button(this);
        ok.setText("连接");
        ok.setTextColor(Color.parseColor("#88C0D0"));
        box.addView(ok, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        ok.setOnClickListener(v -> {
            String url = input.getText().toString().trim();
            if (url.length() > 0 && !url.startsWith("http://") && !url.startsWith("https://")) {
                url = "http://" + url;
            }
            if (url.endsWith("/")) url = url.substring(0, url.length() - 1);
            if (url.length() < 12) return;   // 太短，当成没填
            getSharedPreferences(PREFS, MODE_PRIVATE).edit().putString(KEY_SERVER, url).apply();
            serverUrl = url;
            initWebAndLoad();
        });
        return box;
    }

    /* ---------- 帧二：错误 / 崩溃页 ---------- */
    private LinearLayout buildErrorBox() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setGravity(Gravity.CENTER);
        box.setBackgroundColor(Color.parseColor("#1E222A"));

        TextView title = new TextView(this);
        title.setText("连不上服务器");
        title.setTextColor(Color.parseColor("#E5E9F0"));
        title.setTextSize(18);
        title.setGravity(Gravity.CENTER);
        box.addView(title, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        errMsg = new TextView(this);
        errMsg.setTextColor(Color.parseColor("#8792A3"));
        errMsg.setTextSize(13);
        errMsg.setGravity(Gravity.CENTER);
        errMsg.setPadding(dp(30), dp(10), dp(30), dp(20));
        box.addView(errMsg, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        /* 上次崩溃栈（如果有）：截图发回去就能定位 */
        String crash = getSharedPreferences(PREFS, MODE_PRIVATE).getString(KEY_CRASH, "");
        if (crash.length() > 0) {
            TextView crashTitle = new TextView(this);
            crashTitle.setText("—— 上次崩溃记录（截图发给开发者）——");
            crashTitle.setTextColor(Color.parseColor("#D08770"));
            crashTitle.setTextSize(11);
            crashTitle.setGravity(Gravity.CENTER);
            crashTitle.setPadding(dp(16), dp(14), dp(16), dp(4));
            box.addView(crashTitle, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));

            ScrollView scroll = new ScrollView(this);
            crashView = new TextView(this);
            crashView.setText(crash);
            crashView.setTextColor(Color.parseColor("#BF616A"));
            crashView.setTextSize(9);
            crashView.setPadding(dp(16), 0, dp(16), dp(8));
            scroll.addView(crashView);
            box.addView(scroll, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(200)));

            Button clearCrash = new Button(this);
            clearCrash.setText("清除崩溃记录");
            clearCrash.setTextColor(Color.parseColor("#8792A3"));
            clearCrash.setBackgroundColor(Color.TRANSPARENT);
            clearCrash.setOnClickListener(v -> {
                getSharedPreferences(PREFS, MODE_PRIVATE).edit().remove(KEY_CRASH).apply();
                crashView.setText("");
                crashTitle.setText("");
            });
            box.addView(clearCrash, new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        }

        retryBtn = new Button(this);
        retryBtn.setText("重试");
        retryBtn.setTextColor(Color.parseColor("#88C0D0"));
        retryBtn.setOnClickListener(v -> {
            if (serverUrl.length() == 0) { showFrame(setupBox); return; }
            initWebAndLoad();
        });
        box.addView(retryBtn, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        Button change = new Button(this);
        change.setText("换个服务器地址");
        change.setTextColor(Color.parseColor("#8792A3"));
        change.setBackgroundColor(Color.TRANSPARENT);
        change.setOnClickListener(v -> {
            errMsg.setText("");
            showFrame(setupBox);
        });
        box.addView(change, new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));

        LinearLayout.LayoutParams p = (LinearLayout.LayoutParams) change.getLayoutParams();
        p.topMargin = -dp(14);
        change.setLayoutParams(p);

        box.post(() -> errMsg.setText("地址：" + serverUrl));
        return box;
    }

    /* ---------- 帧三：WebView ---------- */
    private class CairnClient extends WebViewClient {
        @Override
        public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
            if (req.isForMainFrame()) {
                showFrame(errorBox);
            }
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            /* 成功加载无需切换——失败时 onReceivedError 会切到错误页 */
        }
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
