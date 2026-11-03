package com.abhigyanverma.watch;

import android.app.Activity;
import android.content.res.Configuration;
import android.graphics.Color;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;

import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebChromeClient;

/**
 * The whole screen for the film on a phone.
 *
 * Two things kept Android's status bar across the top and its navigation
 * buttons down the side of a film watched sideways (Buffy on a flight,
 * 2026-11):
 *
 *  - Nothing hid them. A page cannot: that is the window's business. So a
 *    phone turned to landscape hides both, the way video apps do, and a
 *    swipe in from the edge shows them for a moment. Upright, they are back.
 *  - The player's fullscreen button did nothing. Capacitor's chrome client
 *    answers every fullscreen request by cancelling it on the spot
 *    (BridgeWebChromeClient.onShowCustomView), so the page only jumped
 *    about. Here the view the WebView hands over is shown over everything,
 *    with the bars hidden, until the page leaves fullscreen.
 *
 * Not on a television, which has no bars and is always sideways.
 */
final class FullscreenViewing {

    private final Activity activity;
    private final Bridge bridge;
    private View fullscreenView;
    private android.webkit.WebChromeClient.CustomViewCallback fullscreenCallback;

    private FullscreenViewing(Activity activity, Bridge bridge) {
        this.activity = activity;
        this.bridge = bridge;
    }

    static FullscreenViewing install(Activity activity, Bridge bridge) {
        FullscreenViewing viewing = new FullscreenViewing(activity, bridge);
        // Bridge has no setter for this one. Must run in onCreate: the client
        // registers activity-result launchers, which Android refuses later.
        bridge.getWebView().setWebChromeClient(new BridgeWebChromeClient(bridge) {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                viewing.show(view, callback);
            }

            @Override
            public void onHideCustomView() {
                viewing.hide();
            }
        });
        viewing.apply();
        return viewing;
    }

    /** Back leaves fullscreen first, as it does in a browser. True if it did. */
    boolean exitIfFullscreen() {
        if (fullscreenView == null) return false;
        // The page's own exit, so the player sees it leave fullscreen and its
        // button state follows; the WebView then calls onHideCustomView.
        bridge.getWebView().evaluateJavascript(
            "document.fullscreenElement&&document.exitFullscreen()", null);
        return true;
    }

    /** Bars hidden in landscape or fullscreen, shown otherwise. Call on every rotation. */
    void apply() {
        WindowInsetsControllerCompat bars =
            WindowCompat.getInsetsController(activity.getWindow(), activity.getWindow().getDecorView());
        boolean landscape =
            activity.getResources().getConfiguration().orientation == Configuration.ORIENTATION_LANDSCAPE;
        if (fullscreenView != null || landscape) {
            bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            bars.hide(WindowInsetsCompat.Type.systemBars());
        } else {
            bars.show(WindowInsetsCompat.Type.systemBars());
        }
    }

    private void show(View view, android.webkit.WebChromeClient.CustomViewCallback callback) {
        if (fullscreenView != null) {
            callback.onCustomViewHidden();
            return;
        }
        fullscreenView = view;
        fullscreenCallback = callback;
        view.setBackgroundColor(Color.BLACK);
        decor().addView(view, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        apply();
    }

    private void hide() {
        if (fullscreenView == null) return;
        decor().removeView(fullscreenView);
        fullscreenView = null;
        if (fullscreenCallback != null) fullscreenCallback.onCustomViewHidden();
        fullscreenCallback = null;
        apply();
    }

    private ViewGroup decor() {
        return (ViewGroup) activity.getWindow().getDecorView();
    }
}
