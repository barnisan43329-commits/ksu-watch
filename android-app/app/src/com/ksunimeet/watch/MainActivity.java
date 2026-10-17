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
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

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
        s.setAllowFileAccess(true);
        // The page lives on file:// and talks to a backend over https/http, so
        // its Origin is "null" and the API answers with Access-Control-Allow-
        // Origin: *. Nothing here needs local file reads from JavaScript.
        s.setAllowFileAccessFromFileURLs(false);
        s.setAllowUniversalAccessFromFileURLs(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_NO_CACHE);

        web.setBackgroundColor(Color.parseColor("#0d1117"));
        web.setWebViewClient(new WebViewClient());
        web.setWebChromeClient(new Chrome());

        root.addView(web, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl("file:///android_asset/www/index.html");
        }
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
