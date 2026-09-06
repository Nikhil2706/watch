package com.abhigyanverma.watch;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.webkit.CookieManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Offline bundles: the storage half of src/lib/offline.
 *
 * A WebView cannot be trusted with several gigabytes — browser storage is
 * evictable, and on a phone that means the film saved for a flight is quietly
 * gone by boarding. So the bytes live in app-private external storage and the
 * web layer only ever sees paths.
 *
 * One bundle per title, laid out as:
 *
 *   offline/&lt;itemId&gt;/media.mp4
 *   offline/&lt;itemId&gt;/poster.jpg
 *   offline/&lt;itemId&gt;/subs/&lt;n&gt;-&lt;lang&gt;.vtt
 *   offline/&lt;itemId&gt;/bundle.json
 *
 * The media goes through the system DownloadManager rather than a thread of
 * our own, for three reasons that all matter on a phone: it keeps going when
 * the app is backgrounded or killed, it resumes a dropped connection against
 * the Range support the server grew for exactly this, and it survives the
 * screen locking. The subtitles and poster are tens of kilobytes, so they are
 * fetched inline and are not worth the same machinery.
 *
 * Every request here carries cookies copied from the WebView's own jar. The
 * session cookie is httpOnly, so the web layer could not hand it over even if
 * it wanted to, and DownloadManager fetches from a different process with no
 * cookies at all — without this, every download succeeds and produces the
 * login page saved as an unplayable file.
 */
@CapacitorPlugin(name = "Offline")
public class OfflinePlugin extends Plugin {

    private static final String BUNDLE_JSON = "bundle.json";
    private static final String MEDIA = "media.mp4";
    private static final String POSTER = "poster.jpg";

    private final ExecutorService io = Executors.newSingleThreadExecutor();

    // ---------------------------------------------------------------- paths

    private File offlineRoot() {
        File root = new File(getContext().getExternalFilesDir(null), "offline");
        if (!root.exists() && !root.mkdirs()) {
            // Nothing useful to do here; callers surface the resulting failure.
        }
        return root;
    }

    /**
     * Item ids come from Jellyfin and are hex, but this is a filesystem path
     * built from a server-provided string, so it gets sanitised rather than
     * trusted. Anything outside [A-Za-z0-9_-] becomes an underscore, which
     * also rules out "..".
     */
    private File bundleDir(String itemId) {
        return new File(offlineRoot(), itemId.replaceAll("[^A-Za-z0-9_-]", "_"));
    }

    // --------------------------------------------------------------- plugin

    @PluginMethod
    public void start(PluginCall call) {
        JSObject manifest = call.getObject("manifest");
        if (manifest == null) {
            call.reject("No manifest given.");
            return;
        }
        final String itemId = manifest.getString("itemId");
        if (itemId == null || itemId.isEmpty()) {
            call.reject("Manifest has no itemId.");
            return;
        }

        io.execute(() -> {
            try {
                File dir = bundleDir(itemId);
                if (!dir.exists() && !dir.mkdirs()) {
                    throw new IOException("Could not create " + dir);
                }

                JSONObject record = new JSONObject();
                record.put("itemId", itemId);
                record.put("title", manifest.getString("title", itemId));
                record.put("year", manifest.opt("year"));
                record.put("durationSeconds", manifest.opt("durationSeconds"));
                record.put("subtitles", manifest.opt("subtitles"));
                record.put("state", "downloading");
                record.put("error", JSONObject.NULL);

                // Subtitles and the poster first: they are small, and a bundle
                // whose media is still arriving is far more useful with its
                // subtitle list already on disk than the other way round.
                JSONArray subs = manifest.optJSONArray("subtitles");
                if (subs != null) {
                    File subDir = new File(dir, "subs");
                    if (!subDir.exists()) subDir.mkdirs();
                    for (int i = 0; i < subs.length(); i++) {
                        JSONObject track = subs.optJSONObject(i);
                        if (track == null) continue;
                        String url = track.optString("url", null);
                        String name = track.optString("filename", null);
                        if (url == null || name == null) continue;
                        try {
                            fetchTo(absolute(url), new File(subDir, name));
                        } catch (Exception e) {
                            // A missing subtitle is a worse film, not a failed
                            // download. Keep going.
                        }
                    }
                }

                String poster = manifest.getString("poster");
                if (poster != null && !poster.isEmpty()) {
                    try {
                        fetchTo(absolute(poster), new File(dir, POSTER));
                    } catch (Exception ignored) {
                    }
                }

                JSObject media = manifest.getJSObject("media");
                String mediaUrl = media == null ? null : media.getString("url");
                if (mediaUrl == null) throw new IOException("Manifest has no media url.");

                File target = new File(dir, MEDIA);
                if (target.exists() && !target.delete()) {
                    throw new IOException("Could not clear the previous file.");
                }

                DownloadManager.Request request =
                    new DownloadManager.Request(Uri.parse(absolute(mediaUrl)));
                String cookie = CookieManager.getInstance().getCookie(absolute(mediaUrl));
                if (cookie != null) request.addRequestHeader("Cookie", cookie);
                request.setTitle(manifest.getString("title", "Download"));
                request.setDescription("Saving for offline");
                request.setNotificationVisibility(
                    DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                request.setDestinationUri(Uri.fromFile(target));
                request.setAllowedOverRoaming(false);

                DownloadManager dm =
                    (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
                long id = dm.enqueue(request);
                record.put("downloadId", id);

                writeJson(new File(dir, BUNDLE_JSON), record);
                call.resolve();
            } catch (Exception e) {
                call.reject("Could not start the download: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void list(PluginCall call) {
        io.execute(() -> {
            JSArray out = new JSArray();
            File[] dirs = offlineRoot().listFiles(File::isDirectory);
            if (dirs != null) {
                for (File dir : dirs) {
                    JSObject bundle = describe(dir);
                    if (bundle != null) out.put(bundle);
                }
            }
            JSObject result = new JSObject();
            result.put("bundles", out);
            call.resolve(result);
        });
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String itemId = call.getString("itemId");
        if (itemId == null) {
            call.reject("No itemId given.");
            return;
        }
        io.execute(() -> {
            File dir = bundleDir(itemId);
            JSONObject record = readJson(new File(dir, BUNDLE_JSON));
            if (record != null) {
                long id = record.optLong("downloadId", -1);
                if (id >= 0) {
                    // Cancels it if still running; harmless if already finished.
                    DownloadManager dm =
                        (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
                    dm.remove(id);
                }
            }
            deleteTree(dir);
            call.resolve();
        });
    }

    @PluginMethod
    public void localUrl(PluginCall call) {
        String itemId = call.getString("itemId");
        String file = call.getString("file");
        if (itemId == null || file == null) {
            call.reject("itemId and file are both required.");
            return;
        }
        File dir = bundleDir(itemId);
        File target = "media".equals(file)
            ? new File(dir, MEDIA)
            : "poster".equals(file)
                ? new File(dir, POSTER)
                : new File(new File(dir, "subs"), file.replaceAll("[^A-Za-z0-9_.-]", "_"));

        JSObject result = new JSObject();
        result.put("url", target.exists() ? target.getAbsolutePath() : null);
        call.resolve(result);
    }

    // ---------------------------------------------------------------- guts

    /** Reads one bundle's state, folding in live DownloadManager progress. */
    private JSObject describe(File dir) {
        JSONObject record = readJson(new File(dir, BUNDLE_JSON));
        if (record == null) return null;

        JSObject out = new JSObject();
        out.put("itemId", record.optString("itemId"));
        out.put("title", record.optString("title"));
        out.put("year", record.isNull("year") ? null : record.opt("year"));
        out.put("durationSeconds",
            record.isNull("durationSeconds") ? null : record.opt("durationSeconds"));
        out.put("subtitles", record.opt("subtitles"));

        File media = new File(dir, MEDIA);
        long downloadId = record.optLong("downloadId", -1);
        String state = record.optString("state", "queued");
        long done = media.exists() ? media.length() : 0;
        long total = -1;
        String error = null;

        if (downloadId >= 0) {
            DownloadManager dm =
                (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);
            try (Cursor c = dm.query(new DownloadManager.Query().setFilterById(downloadId))) {
                if (c != null && c.moveToFirst()) {
                    int status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
                    done = c.getLong(
                        c.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
                    total = c.getLong(
                        c.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        state = "ready";
                    } else if (status == DownloadManager.STATUS_FAILED) {
                        state = "failed";
                        error = "The download did not finish.";
                    } else {
                        state = "downloading";
                    }
                } else {
                    // The row is gone — cleared by the system, or the device
                    // was wiped of downloads. Trust the file on disk instead.
                    state = media.exists() && media.length() > 0 ? "ready" : "failed";
                    if ("failed".equals(state)) error = "The download was cancelled.";
                }
            } catch (Exception e) {
                state = media.exists() ? "ready" : "failed";
            }
        }

        int progress = 0;
        if ("ready".equals(state)) {
            progress = 100;
        } else if (total > 0) {
            progress = (int) Math.max(0, Math.min(100, (done * 100) / total));
        }

        out.put("state", state);
        out.put("progress", progress);
        out.put("bytesDone", done);
        out.put("bytesTotal", total > 0 ? total : null);
        out.put("error", error);
        return out;
    }

    /** Resolves a site-relative manifest URL against the origin being viewed. */
    private String absolute(String url) {
        if (url.startsWith("http://") || url.startsWith("https://")) return url;
        String base = getBridge().getWebView().getUrl();
        try {
            return new URL(new URL(base), url).toString();
        } catch (Exception e) {
            return url;
        }
    }

    private void fetchTo(String url, File target) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) conn.setRequestProperty("Cookie", cookie);
        try (InputStream in = conn.getInputStream();
             FileOutputStream out = new FileOutputStream(target)) {
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        } finally {
            conn.disconnect();
        }
    }

    private void writeJson(File target, JSONObject value) throws IOException {
        try (FileOutputStream out = new FileOutputStream(target)) {
            out.write(value.toString().getBytes(StandardCharsets.UTF_8));
        }
    }

    private JSONObject readJson(File source) {
        if (!source.exists()) return null;
        try (InputStream in = new java.io.FileInputStream(source)) {
            java.io.ByteArrayOutputStream buf = new java.io.ByteArrayOutputStream();
            byte[] chunk = new byte[4096];
            int n;
            while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
            return new JSONObject(buf.toString("UTF-8"));
        } catch (Exception e) {
            return null;
        }
    }

    private void deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        // Best effort: a file we cannot remove shows up as a bundle that will
        // not go away, which is visible, rather than a silent half-deletion.
        file.delete();
    }
}
