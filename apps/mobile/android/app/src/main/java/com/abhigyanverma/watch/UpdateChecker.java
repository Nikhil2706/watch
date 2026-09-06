package com.abhigyanverma.watch;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.widget.Toast;

import androidx.core.content.FileProvider;

import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * Self-update, because this app is sideloaded and there is no store to do it.
 *
 * On launch it fetches a small JSON descriptor published alongside each GitHub
 * release, compares versionCode against the running build, and offers the
 * update. Accepting downloads the APK and hands it to the system installer.
 *
 * Three things about Android make or break this:
 *
 *  - The installer will only replace an existing app when the new APK is
 *    signed with the SAME key. That is why the release keystore exists; with
 *    the old per-build debug keys this whole feature would be impossible.
 *  - Since API 24 you may not hand a file:// URI to another app. The APK goes
 *    through a FileProvider as a content:// URI with read permission granted,
 *    or the installer throws FileUriExposedException.
 *  - Since API 26 "install unknown apps" is granted per-app, not globally, so
 *    the first update sends the user to that settings screen. Nothing can
 *    install silently without being a device owner, so the system's own
 *    confirmation screen always appears. That is by design, not a gap.
 */
final class UpdateChecker {

    // GitHub serves /releases/latest/download/<asset> as a permanent redirect to
    // whatever the newest release holds, so no API call and no rate limit.
    private static final String BASE =
        "https://github.com/Nikhil2706/watch/releases/latest/download/";
    private static final String MANIFEST_URL = BASE + "latest.json";
    private static final String APK_NAME = "watch-update.apk";

    private UpdateChecker() {}

    static void checkInBackground(final Activity activity) {
        new Thread(() -> {
            try {
                JSONObject latest = fetchJson(MANIFEST_URL);
                int latestCode = latest.getInt("versionCode");
                String latestName = latest.optString("versionName", String.valueOf(latestCode));
                String apkUrl = latest.optString("apk", BASE + "watch-release.apk");

                PackageInfo info = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
                int current = (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P)
                    ? (int) info.getLongVersionCode()
                    : info.versionCode;

                if (latestCode > current) {
                    new Handler(Looper.getMainLooper())
                        .post(() -> prompt(activity, latestName, apkUrl));
                }
            } catch (Exception e) {
                // Offline, GitHub unreachable, malformed descriptor - a failed
                // update check must never be something the user has to see.
            }
        }, "update-check").start();
    }

    private static JSONObject fetchJson(String url) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        c.setConnectTimeout(10000);
        c.setReadTimeout(10000);
        c.setInstanceFollowRedirects(true);
        try (InputStream in = c.getInputStream()) {
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[4096];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return new JSONObject(out.toString("UTF-8"));
        } finally {
            c.disconnect();
        }
    }

    private static void prompt(Activity activity, String versionName, String apkUrl) {
        if (activity.isFinishing()) return;
        new AlertDialog.Builder(activity)
            .setTitle("Update available")
            .setMessage("Watch " + versionName + " is ready to install.")
            .setPositiveButton("Update", (d, w) -> startDownload(activity, apkUrl))
            .setNegativeButton("Later", null)
            .show();
    }

    private static void startDownload(Activity activity, String apkUrl) {
        try {
            // App-private external storage: needs no permission on any API level,
            // and FileProvider below is configured to expose exactly this folder.
            File target = new File(
                activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_NAME);
            if (target.exists() && !target.delete()) {
                Toast.makeText(activity, "Could not clear the previous download",
                    Toast.LENGTH_LONG).show();
                return;
            }

            DownloadManager.Request req = new DownloadManager.Request(Uri.parse(apkUrl));
            req.setTitle("Watch update");
            req.setMimeType("application/vnd.android.package-archive");
            req.setNotificationVisibility(
                DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            req.setDestinationInExternalFilesDir(
                activity, Environment.DIRECTORY_DOWNLOADS, APK_NAME);

            DownloadManager dm =
                (DownloadManager) activity.getSystemService(Context.DOWNLOAD_SERVICE);
            long id = dm.enqueue(req);
            Toast.makeText(activity, "Downloading update…", Toast.LENGTH_SHORT).show();
            awaitDownload(activity, dm, id, target);
        } catch (Exception e) {
            Toast.makeText(activity, "Could not start the update", Toast.LENGTH_LONG).show();
        }
    }

    /**
     * Polls rather than registering a DownloadManager broadcast receiver: the
     * receiver route needs an explicit exported flag from API 34 and is easy to
     * leak across a rotation. This costs one query a second for the length of
     * one download.
     */
    private static void awaitDownload(Activity activity, DownloadManager dm,
                                      long id, File target) {
        final Handler handler = new Handler(Looper.getMainLooper());
        handler.post(new Runnable() {
            int ticks = 0;

            @Override
            public void run() {
                if (activity.isFinishing()) return;
                if (++ticks > 1800) return;   // 30 minutes, then give up quietly

                int status = -1;
                try (Cursor cur = dm.query(new DownloadManager.Query().setFilterById(id))) {
                    if (cur != null && cur.moveToFirst()) {
                        status = cur.getInt(cur.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    }
                } catch (Exception ignored) {
                }

                if (status == DownloadManager.STATUS_SUCCESSFUL) {
                    install(activity, target);
                } else if (status == DownloadManager.STATUS_FAILED) {
                    Toast.makeText(activity, "Update download failed", Toast.LENGTH_LONG).show();
                } else {
                    handler.postDelayed(this, 1000);
                }
            }
        });
    }

    private static void install(Activity activity, File apk) {
        // API 26+: permission to install is granted per-app, so send the user to
        // the screen that grants it rather than failing with nothing on screen.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                && !activity.getPackageManager().canRequestPackageInstalls()) {
            Toast.makeText(activity,
                "Allow installing apps from Watch, then tap Update again",
                Toast.LENGTH_LONG).show();
            activity.startActivity(
                new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + activity.getPackageName())));
            return;
        }

        try {
            Uri uri = FileProvider.getUriForFile(
                activity, activity.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_ACTIVITY_NEW_TASK);
            activity.startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(activity, "Could not open the installer", Toast.LENGTH_LONG).show();
        }
    }
}
