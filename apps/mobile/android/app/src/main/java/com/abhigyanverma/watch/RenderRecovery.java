package com.abhigyanverma.watch;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.SystemClock;
import android.util.Log;
import android.webkit.WebView;

import com.getcapacitor.Bridge;

/**
 * What happens when the WebView's renderer process dies.
 *
 * Android's default is to kill the app with it: "Render process's crash
 * wasn't handled by all associated webviews, triggering application crash."
 * That is what the Mi TV did on 2026-11-02, twice, opening an episode after
 * about fifty minutes of a transcoded one had filled its 1.8 GB (the site's
 * side of that is src/lib/tv-memory.ts). A renderer can also be killed by
 * the system to free memory, which ends the same way.
 *
 * Handled instead: the dead WebView cannot be used again, so the screen is
 * started afresh — a new WebView, a new renderer — on the page that was open.
 * The watch page resumes from the position the player last reported. A second
 * crash within a minute starts at Home instead, so a page that crashes every
 * time it opens cannot loop.
 */
final class RenderRecovery {

    static final String EXTRA_RESUME_URL = "com.abhigyanverma.watch.RESUME_URL";

    private static final String TAG = "RenderRecovery";

    /** A second crash within this long is a page that keeps crashing. */
    private static final long LOOP_WINDOW_MS = 60_000;

    /** When the renderer last died, in this process (elapsedRealtime); 0 for never. */
    private static long lastCrashAt = 0;

    private RenderRecovery() {}

    /** Always true: the crash is handled, so Android does not kill the app. */
    static boolean recover(Bridge bridge, WebView view, boolean crashed) {
        Activity activity = bridge.getActivity();
        String url = view.getUrl();
        long now = SystemClock.elapsedRealtime();
        boolean looping = lastCrashAt != 0 && now - lastCrashAt < LOOP_WINDOW_MS;
        lastCrashAt = now;
        Log.w(TAG, "renderer " + (crashed ? "crashed" : "was killed by the system") + " on " + url
                + (looping ? "; again within a minute, starting at Home" : "; reopening it"));

        Intent intent = new Intent(activity, MainActivity.class);
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        if (!looping && sameOrigin(url, bridge.getServerUrl())) intent.putExtra(EXTRA_RESUME_URL, url);
        activity.startActivity(intent);
        activity.finish();
        return true;
    }

    /** The page to reopen after a recovery, or null to start as usual. Only ever one on the site's own origin. */
    static String resumeUrl(Intent intent, Bridge bridge) {
        if (intent == null) return null;
        String url = intent.getStringExtra(EXTRA_RESUME_URL);
        return sameOrigin(url, bridge.getServerUrl()) ? url : null;
    }

    private static boolean sameOrigin(String url, String server) {
        if (url == null || server == null) return false;
        Uri a = Uri.parse(url);
        Uri b = Uri.parse(server);
        return a.getScheme() != null && a.getScheme().equals(b.getScheme())
                && a.getHost() != null && a.getHost().equals(b.getHost())
                && a.getPort() == b.getPort();
    }
}
