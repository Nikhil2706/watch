package com.abhigyanverma.watch;

import android.net.Uri;
import android.os.Build;
import android.webkit.ServiceWorkerClient;
import android.webkit.ServiceWorkerController;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Serves a kept-offline film to the page's video element, with real Range
 * support.
 *
 * Capacitor's own file route (convertFileSrc, /_capacitor_file_/) cannot play
 * these. Its Range handling (WebViewLocalServer, 7.x) takes the file's size
 * from InputStream.available() into an int, and never seeks: every range
 * answers from byte 0. A 2.4 GB film came back as "bytes 0-99/0", the video
 * element saw an empty file, and nothing played. Smaller films would start but
 * break on the first seek.
 *
 * So media is served from a path of our own on the page's origin -
 * &lt;server&gt;/_watch_offline_/&lt;itemId&gt;/media.mp4 - intercepted here before it
 * reaches the network. Same origin as the page, so no CORS, no mixed content,
 * and it works with no connection at all. Everything else falls through to
 * Capacitor untouched.
 */
final class OfflineMedia {

    static final String PREFIX = "/_watch_offline_/";

    private OfflineMedia() {}

    /** The page-facing URL for an item's media file. */
    static String urlFor(Bridge bridge, String itemId) {
        return bridge.getServerUrl() + PREFIX + sanitise(itemId) + "/" + OfflinePlugin.MEDIA;
    }

    /**
     * Answers our prefix ahead of Capacitor, on both paths a request can take.
     * The site registers a service worker (sw.js), and once it controls the
     * page every request - the video's included - arrives through the
     * ServiceWorkerClient, never touching the WebViewClient. Hooking only the
     * WebViewClient worked on a first visit and 404'd on every one after.
     */
    static void install(Bridge bridge) {
        bridge.setWebViewClient(new BridgeWebViewClient(bridge) {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                WebResourceResponse ours = intercept(bridge, request);
                return ours != null ? ours : super.shouldInterceptRequest(view, request);
            }
        });
        if (Build.VERSION.SDK_INT >= 24) {
            // Replaces Capacitor's own (Bridge, when resolveServiceWorkerRequests
            // is on), which only forwards to the local server - kept as the fallback.
            ServiceWorkerController.getInstance().setServiceWorkerClient(new ServiceWorkerClient() {
                @Override
                public WebResourceResponse shouldInterceptRequest(WebResourceRequest request) {
                    WebResourceResponse ours = intercept(bridge, request);
                    return ours != null ? ours : bridge.getLocalServer().shouldInterceptRequest(request);
                }
            });
        }
    }

    private static WebResourceResponse intercept(Bridge bridge, WebResourceRequest request) {
        Uri url = request.getUrl();
        String path = url.getPath();
        if (path == null || !path.startsWith(PREFIX)) return null;
        // Only on the origin the shell loads; a page elsewhere gets nothing.
        Uri server = Uri.parse(bridge.getServerUrl());
        if (!sameOrigin(url, server)) return null;

        String[] parts = path.substring(PREFIX.length()).split("/");
        if (parts.length != 2 || !OfflinePlugin.MEDIA.equals(parts[1])) return plain(404, "Not Found");

        File file = new File(OfflinePlugin.bundleDir(bridge.getContext(), parts[0]), OfflinePlugin.MEDIA);
        return serve(file, header(request.getRequestHeaders(), "Range"));
    }

    static WebResourceResponse serve(File file, String range) {
        if (!file.isFile()) return plain(404, "Not Found");
        long size = file.length();
        long start = 0;
        long end = size - 1;
        boolean partial = false;

        if (range != null && range.startsWith("bytes=")) {
            // One range only - it is all a media element ever asks for.
            String spec = range.substring(6).split(",")[0].trim();
            int dash = spec.indexOf('-');
            try {
                if (dash < 0) throw new NumberFormatException();
                String from = spec.substring(0, dash).trim();
                String to = spec.substring(dash + 1).trim();
                if (from.isEmpty()) {
                    start = Math.max(0, size - Long.parseLong(to)); // suffix: last N bytes
                } else {
                    start = Long.parseLong(from);
                    if (!to.isEmpty()) end = Math.min(Long.parseLong(to), size - 1);
                }
            } catch (NumberFormatException e) {
                return plain(416, "Range Not Satisfiable");
            }
            if (start >= size || start > end) {
                Map<String, String> h = new HashMap<>();
                h.put("Content-Range", "bytes */" + size);
                return new WebResourceResponse("text/plain", "utf-8", 416, "Range Not Satisfiable", h,
                    new ByteArrayInputStream(new byte[0]));
            }
            partial = true;
        }

        long length = end - start + 1;
        InputStream body;
        try {
            // From byte 0, NOT from start: the WebView applies the request's
            // Range to an intercepted stream itself, skipping to the first
            // byte. Seeking here as well skipped twice and failed every
            // request that did not begin at 0. Only the end is ours to cut.
            body = new Bounded(new FileInputStream(file), end + 1);
        } catch (IOException e) {
            return plain(500, "Internal Server Error");
        }

        Map<String, String> headers = new HashMap<>();
        headers.put("Accept-Ranges", "bytes");
        headers.put("Content-Length", Long.toString(length));
        headers.put("Cache-Control", "no-store");
        if (partial) headers.put("Content-Range", "bytes " + start + "-" + end + "/" + size);
        return new WebResourceResponse("video/mp4", null, partial ? 206 : 200,
            partial ? "Partial Content" : "OK", headers, body);
    }

    static String sanitise(String itemId) {
        return itemId.replaceAll("[^A-Za-z0-9_-]", "_");
    }

    private static boolean sameOrigin(Uri a, Uri b) {
        return eq(a.getScheme(), b.getScheme()) && eq(a.getHost(), b.getHost()) && port(a) == port(b);
    }

    private static int port(Uri u) {
        if (u.getPort() != -1) return u.getPort();
        return "https".equals(u.getScheme()) ? 443 : 80;
    }

    private static boolean eq(String x, String y) {
        return x == null ? y == null : x.equalsIgnoreCase(y);
    }

    private static String header(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (name.equalsIgnoreCase(e.getKey())) return e.getValue();
        }
        return null;
    }

    private static WebResourceResponse plain(int status, String reason) {
        return new WebResourceResponse("text/plain", "utf-8", status, reason, new HashMap<>(),
            new ByteArrayInputStream(new byte[0]));
    }

    /**
     * Ends at the last requested byte instead of running to end of file.
     *
     * available() reports 0 on purpose. The WebView checks the requested range
     * against available(), an int, before skipping - so any honest answer for
     * a film over 2 GB would be wrong, and a seek past 2 GB would be refused as
     * unsatisfiable. With 0 it skips the check; the bounds were already
     * checked above against the real, long, file length.
     */
    private static final class Bounded extends FilterInputStream {
        private long remaining;

        Bounded(InputStream in, long length) {
            super(in);
            this.remaining = length;
        }

        /**
         * At most 1 GiB per call. The WebView's skip loop carries the count
         * back through a 32-bit int: skipping 2^31 bytes in one go came back
         * negative, read as "cannot skip", and every seek into the last part
         * of a film over 2 GiB failed. It loops until it reaches the start,
         * so smaller steps lose nothing.
         */
        @Override
        public long skip(long n) throws IOException {
            long want = Math.min(Math.min(n, remaining), 1L << 30);
            if (want <= 0) return 0;
            long skipped = super.skip(want);
            if (skipped > 0) remaining -= skipped;
            return skipped;
        }

        @Override
        public int read() throws IOException {
            if (remaining <= 0) return -1;
            int b = super.read();
            if (b >= 0) remaining--;
            return b;
        }

        @Override
        public int read(byte[] buf, int off, int len) throws IOException {
            if (remaining <= 0) return -1;
            int n = super.read(buf, off, (int) Math.min(len, remaining));
            if (n > 0) remaining -= n;
            return n;
        }

        @Override
        public int available() {
            return 0;
        }
    }
}
