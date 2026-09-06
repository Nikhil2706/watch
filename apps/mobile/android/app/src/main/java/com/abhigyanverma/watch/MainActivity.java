package com.abhigyanverma.watch;

import android.app.DownloadManager;
import android.app.UiModeManager;
import android.content.Context;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Bundle;
import android.os.Environment;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.WebSettings;
import android.widget.Toast;

import com.getcapacitor.BridgeActivity;

/**
 * Capacitor's BridgeActivity on its own is what this used to be - one empty
 * line - and that quietly broke every download in the app.
 *
 * An Android WebView does not download anything by itself. When a response
 * comes back as an attachment rather than something it can render, it hands it
 * to a DownloadListener, and if none is registered it simply drops it. No
 * error, no callback, nothing on screen. So the site's "Download film" button
 * (a plain link to /jf/Items/{id}/Download, Content-Disposition: attachment)
 * and the subtitle links did exactly nothing when tapped inside the app, while
 * working fine in a browser on the same phone.
 *
 * Handing the URL to the system DownloadManager fixes that, with one catch
 * worth knowing about: DownloadManager fetches from a different process, so it
 * gets none of the WebView's cookies. Those routes authenticate on jfg_session,
 * so without the Cookie header copied across every download would come back as
 * the login page - a file that looks like it downloaded and is unplayable.
 */
public class MainActivity extends BridgeActivity {

    /**
     * The site already has a full TV mode — ten-foot CSS, D-pad roving focus,
     * an on-screen keyboard and pairing-code login (src/components/tv,
     * src/lib/tv). It turns it on by matching the user agent against patterns
     * like "androidtv" and "aft*", or by a watch_tv cookie.
     *
     * The catch: Android System WebView on a TV box does NOT advertise itself
     * as a television. Its user agent is an ordinary Android Chrome one, so
     * every one of those patterns misses and the TV would get the phone layout
     * — unreadable at three metres and unnavigable without a touchscreen.
     *
     * So the shell says what the WebView will not. One word appended to the
     * user agent, only on an actual television, and the site's own existing
     * detection does the rest. Nothing here reimplements any of it.
     */
    private void announceTelevisionToTheSite() {
        if (!isTelevision()) return;

        WebSettings settings = this.bridge.getWebView().getSettings();
        String ua = settings.getUserAgentString();
        if (ua == null || ua.contains("AndroidTV")) return;

        settings.setUserAgentString(ua + " AndroidTV");
        // Capacitor has already begun loading the start URL by the time
        // onCreate runs, so the first request went out with the unmodified
        // agent. Reloading is the cheap, reliable fix — one extra request at
        // launch, on TVs only, in exchange for never rendering the phone
        // layout on a television.
        this.bridge.getWebView().reload();
    }

    private boolean isTelevision() {
        if (getPackageManager().hasSystemFeature(PackageManager.FEATURE_LEANBACK)) return true;
        // Older or unusual boxes may not declare leanback; the ui mode is the
        // other half of the answer and costs nothing to check.
        UiModeManager ui = (UiModeManager) getSystemService(Context.UI_MODE_SERVICE);
        return ui != null && ui.getCurrentModeType() == Configuration.UI_MODE_TYPE_TELEVISION;
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        announceTelevisionToTheSite();

        // Sideloaded, so no store pushes updates. Fire-and-forget on a
        // background thread; it stays silent unless there is something newer.
        UpdateChecker.checkInBackground(this);

        this.bridge.getWebView().setDownloadListener(
            (url, userAgent, contentDisposition, mimeType, contentLength) -> {
                try {
                    DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));

                    String cookie = CookieManager.getInstance().getCookie(url);
                    if (cookie != null) {
                        request.addRequestHeader("Cookie", cookie);
                    }
                    request.addRequestHeader("User-Agent", userAgent);

                    // Content-Disposition carries the real title; the URL is an item id.
                    String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
                    request.setTitle(name);
                    request.setMimeType(mimeType);
                    request.setNotificationVisibility(
                        DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);

                    try {
                        // The phone's own Downloads folder, so the file is somewhere
                        // the person can actually find it. Needs no permission from
                        // API 29 on; below that it needs the legacy storage
                        // permission declared in AndroidManifest.xml, which may not
                        // have been granted - hence the fallback.
                        request.setDestinationInExternalPublicDir(
                            Environment.DIRECTORY_DOWNLOADS, name);
                    } catch (Exception e) {
                        request.setDestinationInExternalFilesDir(
                            this, Environment.DIRECTORY_DOWNLOADS, name);
                    }

                    DownloadManager dm = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
                    dm.enqueue(request);

                    // DownloadManager works in the background and the page does not
                    // change, so without this a tap looks like it did nothing.
                    Toast.makeText(this, "Downloading " + name, Toast.LENGTH_SHORT).show();
                } catch (Exception e) {
                    Toast.makeText(this, "Could not start the download", Toast.LENGTH_LONG).show();
                }
            });
    }
}
