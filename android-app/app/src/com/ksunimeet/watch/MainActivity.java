package com.ksunimeet.watch;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.webkit.MimeTypeMap;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStream;

/**
 * KsuNiMeet Watch — a window for the page in assets/www.
 *
 * THERE IS NO NATIVE PLAYER HERE ON PURPOSE. The film is played by the page's
 * own <video>, from a blob built out of the file the person picked. That keeps
 * one implementation of the sync instead of two, and it means the same code
 * runs in a browser on GitHub Pages and inside this APK.
 *
 * What the shell has to supply, and nothing more:
 *
 *   - a file chooser, because <input type=file> does nothing in a WebView
 *     unless the app answers onShowFileChooser;
 *   - permission for the page to start playback without a tap, because a
 *     play pressed on the OTHER phone has no gesture in this one — without
 *     this flag the receiving side simply does not start;
 *   - a real fullscreen surface for the video, and the screen kept awake;
 *   - the back button, which must leave the video before it leaves the app.
 */
public class MainActivity extends Activity {

    private static final int PICK_FILE = 101;

    /* WHERE THE APP OPENS, AND WHY IT IS THE HOST ITSELF.
     *
     * The page and the API are served from one folder on the PHP host, so
     * opening it there means every room call is same-origin: no CORS, no
     * relay, no door, no third-party allowance, nothing to configure and
     * nothing that can run out. The app carries no backend address of its own
     * any more, because there is no longer anything to point at.
     *
     * WHY NOT file://, which is what this used to be. A page on file:// has an
     * opaque origin and a WebView refuses every fetch from it — the app opened
     * and failed on the first button. */
    private static final String PAGE = "https://ksunimeet.gt.tc/watch/";

    /* The copy inside the APK is no longer the app; it is the page shown when
     * there is no signal, served from an https origin of our own so its own
     * retry logic still works instead of hitting an opaque-origin wall. */
    private static final String OFFLINE = "https://appassets.ksuwatch/www/index.html";
    private static final String ASSETS_HOST = "appassets.ksuwatch";

    private WebView web;
    private FrameLayout root;
    private View customView;              // the video's fullscreen surface
    private WebChromeClient.CustomViewCallback customCallback;
    private ValueCallback<Uri[]> pendingFiles;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 21) {
            getWindow().setStatusBarColor(Color.parseColor("#0d1117"));
            getWindow().setNavigationBarColor(Color.parseColor("#0d1117"));
        }

        root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0d1117"));

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        // Nothing in the page reads local files: the film comes from the
        // picker as a content:// stream, the interface from the intercept.
        s.setAllowFileAccess(false);
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setBackgroundColor(Color.parseColor("#0d1117"));
        web.setWebViewClient(new Assets());
        web.setWebChromeClient(new Chrome());

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(PAGE);
        }
    }

    /** assets/www, handed to the WebView as if it were a website. */
    private class Assets extends WebViewClient {

        /* No signal, or the host is down: show the bundled page instead of
         * Android's grey "webpage not available". It is the same app, it says
         * "not connected — retrying", and it recovers by itself.
         *
         * Only the MAIN frame is redirected. A failed asset, an ad blocker or
         * a missing favicon must never replace the page somebody is watching. */
        @Override
        public void onReceivedError(WebView view, WebResourceRequest req,
                                    WebResourceError err) {
            if (req != null && req.isForMainFrame()) {
                goOffline();
            }
        }

        @SuppressWarnings("deprecation")
        @Override
        public void onReceivedError(WebView view, int code, String description,
                                    String failingUrl) {
            if (failingUrl != null && !failingUrl.startsWith(OFFLINE)) {
                goOffline();
            }
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest req) {
            Uri url = req.getUrl();
            if (url == null || !ASSETS_HOST.equals(url.getHost())) {
                return null;                 // the backend: let it go to the network
            }
            String path = url.getPath();
            if (path == null) {
                return null;
            }
            while (path.startsWith("/")) {
                path = path.substring(1);
            }
            if (path.isEmpty()) {
                path = "www/index.html";
            }
            if (path.contains("..")) {
                return null;
            }

            String ext = MimeTypeMap.getFileExtensionFromUrl("/" + path);
            String mime = ext == null ? null : MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext);
            if (mime == null) {
                mime = "application/octet-stream";
            }
            // Text is text; a film piece is bytes and must not be re-encoded.
            String charset = mime.startsWith("text/") || mime.endsWith("javascript") || mime.endsWith("json")
                    ? "utf-8" : null;

            try {
                InputStream in = getAssets().open(path);
                return new WebResourceResponse(mime, charset, in);
            } catch (IOException e) {
                return new WebResourceResponse("text/plain", "utf-8",
                        new ByteArrayInputStream(("missing asset: " + path).getBytes()));
            }
        }
    }

    /** Point the shell at the bundled page, once, and never in a loop. */
    private void goOffline() {
        if (web == null) {
            return;
        }
        String now = web.getUrl();
        if (now != null && now.startsWith(OFFLINE)) {
            return;
        }
        web.loadUrl(OFFLINE);
    }

    /** Leaving the video, going back inside the page, then leaving the app. */
    @Override
    public void onBackPressed() {
        if (customView != null) {
            ((Chrome) web.getWebChromeClient()).onHideCustomView();
            return;
        }
        if (web.canGoBack()) {
            web.goBack();
            return;
        }
        super.onBackPressed();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    /* ------------------------------------------------------- file chooser -- */

    @Override
    protected void onActivityResult(int req, int res, Intent data) {
        if (req != PICK_FILE) {
            super.onActivityResult(req, res, data);
            return;
        }
        Uri[] out = null;
        if (res == RESULT_OK && data != null) {
            if (data.getClipData() != null) {
                int n = data.getClipData().getItemCount();
                out = new Uri[n];
                for (int i = 0; i < n; i++) {
                    out[i] = data.getClipData().getItemAt(i).getUri();
                }
            } else if (data.getData() != null) {
                out = new Uri[]{data.getData()};
            }
        }
        if (pendingFiles != null) {
            pendingFiles.onReceiveValue(out);
            pendingFiles = null;
        }
    }

    /* -------------------------------------------------------------- chrome -- */

    private class Chrome extends WebChromeClient {

        @Override
        public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> done,
                                         FileChooserParams params) {
            if (pendingFiles != null) {
                pendingFiles.onReceiveValue(null);
            }
            pendingFiles = done;

            Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
            pick.addCategory(Intent.CATEGORY_OPENABLE);
            // The page asks for video/*; a phone that offers only "video" still
            // lists .mkv and .mp4 files by their mime, which is what we want.
            pick.setType("video/*");
            pick.putExtra(Intent.EXTRA_LOCAL_ONLY, true);

            try {
                startActivityForResult(Intent.createChooser(pick, getString(R.string.choose_file)),
                        PICK_FILE);
            } catch (Exception e) {
                pendingFiles = null;
                return false;
            }
            return true;
        }

        @Override
        public void onShowCustomView(View view, CustomViewCallback callback) {
            if (customView != null) {
                callback.onCustomViewHidden();
                return;
            }
            customView = view;
            customCallback = callback;
            root.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT,
                    ViewGroup.LayoutParams.MATCH_PARENT));
            web.setVisibility(View.GONE);
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
        }

        @Override
        public void onHideCustomView() {
            if (customView == null) {
                return;
            }
            root.removeView(customView);
            customView = null;
            web.setVisibility(View.VISIBLE);
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN);
            if (customCallback != null) {
                customCallback.onCustomViewHidden();
                customCallback = null;
            }
        }
    }
}
