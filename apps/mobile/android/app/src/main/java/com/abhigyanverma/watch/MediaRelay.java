package com.abhigyanverma.watch;

import android.util.Base64;
import android.util.Log;
import android.webkit.CookieManager;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.Supplier;

/**
 * The on-device video relay: a small HTTP server on 127.0.0.1 that the site's
 * video player loads video from while the app is at home (HomeDoor).
 *
 * The site's player reads `window.__watchMediaBase`
 * (src/lib/media-relay.ts) and, when it is set, loads
 * {base}/jf/Videos/... instead of /jf/Videos/... This relay takes the
 * request, adds the site's sign-in cookies (the player sends none: it is a
 * cross-origin, crossOrigin="anonymous" request), and fetches the same path
 * from the Mac's home door, or from the public site when there is no door.
 * Range requests pass straight through, so seeking works the standard way.
 *
 * Why a real server: on 2026-11-16 a Vu TV's WebView (157, Android 12) would
 * not play video handed to it from the app's request handler, whole (it took
 * in all 291 MB before the player saw any) or in 4 MB pieces (it stopped
 * asking after the first). Pages and pictures were fine that way.
 *
 * Only this app should be able to use it, so it listens on loopback only and
 * every path must start with a random secret made at launch; anything else
 * is 404. HLS playlists that name /jf/ paths are rewritten to carry it.
 */
final class MediaRelay {
    private static final String TAG = "MediaRelay";

    private final String site;
    private final Supplier<String> door;
    private final String secret;
    private ServerSocket server;
    private final ExecutorService pool = Executors.newCachedThreadPool();

    /** `door` returns the home door's origin, or null to fetch from the public site. */
    MediaRelay(String site, Supplier<String> door) {
        this.site = site.replaceAll("/+$", "");
        this.door = door;
        byte[] b = new byte[18];
        new SecureRandom().nextBytes(b);
        this.secret = Base64.encodeToString(b, Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP);
    }

    /** Starts listening; returns the base the page should use, e.g. "http://127.0.0.1:41234/3f9c...". */
    synchronized String start() throws IOException {
        if (server == null) {
            server = new ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"));
            Thread t = new Thread(this::acceptLoop, "media-relay");
            t.setDaemon(true);
            t.start();
        }
        return "http://127.0.0.1:" + server.getLocalPort() + "/" + secret;
    }

    private void acceptLoop() {
        while (true) {
            try {
                Socket s = server.accept();
                pool.execute(() -> serve(s));
            } catch (IOException e) {
                Log.w(TAG, "relay stopped", e);
                return;
            }
        }
    }

    private void serve(Socket s) {
        try (Socket socket = s) {
            socket.setSoTimeout(30_000);
            InputStream in = socket.getInputStream();
            OutputStream out = new BufferedOutputStream(socket.getOutputStream(), 64 * 1024);
            String head = readHead(in);
            if (head == null) return;
            String[] lines = head.split("\r\n");
            String[] first = lines[0].split(" ");
            if (first.length < 2) return;
            String method = first[0];
            String target = first[1];
            Map<String, String> headers = new LinkedHashMap<>();
            for (int i = 1; i < lines.length; i++) {
                int colon = lines[i].indexOf(':');
                if (colon > 0) headers.put(lines[i].substring(0, colon).trim().toLowerCase(Locale.ROOT), lines[i].substring(colon + 1).trim());
            }
            String origin = headers.get("origin");
            String allowOrigin = origin != null && origin.equals(site) ? origin : site;

            String prefix = "/" + secret;
            if (!target.startsWith(prefix + "/jf/")) {
                writeStatus(out, 404, "Not Found", allowOrigin, null);
                out.flush();
                return;
            }
            if (method.equals("OPTIONS")) {
                writeStatus(out, 204, "No Content", allowOrigin, null);
                out.flush();
                return;
            }
            if (!method.equals("GET") && !method.equals("HEAD")) {
                writeStatus(out, 405, "Method Not Allowed", allowOrigin, null);
                out.flush();
                return;
            }
            relay(method, target.substring(prefix.length()), headers, allowOrigin, out);
        } catch (IOException e) {
            // The player dropped the request (a seek, or the page closed): nothing to do.
        } catch (RuntimeException e) {
            Log.w(TAG, "relay request failed", e);
        }
    }

    private void relay(String method, String path, Map<String, String> req, String allowOrigin, OutputStream out) throws IOException {
        String d = door.get();
        String upstream = (d != null ? d : site) + path;
        HttpURLConnection c = (HttpURLConnection) new URL(upstream).openConnection();
        try {
            c.setRequestMethod(method);
            c.setConnectTimeout(5_000);
            // A paused viewer reads nothing for a while; that is not a dead server.
            c.setReadTimeout(60_000);
            c.setUseCaches(false);
            c.setRequestProperty("Accept-Encoding", "identity");
            for (String name : new String[] {"range", "accept", "user-agent", "if-range"}) {
                String v = req.get(name);
                if (v != null) c.setRequestProperty(name, v);
            }
            String cookies = CookieManager.getInstance().getCookie(site);
            if (cookies != null) c.setRequestProperty("Cookie", cookies);

            int code = c.getResponseCode();
            String reason = c.getResponseMessage() == null ? "" : c.getResponseMessage();
            String type = c.getContentType();
            boolean playlist = type != null && type.toLowerCase(Locale.ROOT).contains("mpegurl");

            Map<String, String> keep = new LinkedHashMap<>();
            for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                if (h.getKey() == null || h.getValue() == null || h.getValue().isEmpty()) continue;
                String name = h.getKey().toLowerCase(Locale.ROOT);
                if (name.equals("content-type") || name.equals("content-range") || name.equals("accept-ranges")
                        || name.equals("cache-control") || name.equals("last-modified") || name.equals("etag")
                        || (name.equals("content-length") && !playlist)) {
                    keep.put(h.getKey(), String.join(", ", h.getValue()));
                }
            }

            InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
            if (playlist && body != null && method.equals("GET")) {
                // Segment and variant paths in an HLS playlist are /jf/...; they must
                // come back through this relay, so they carry the secret too.
                byte[] text = readAll(body).getBytes(StandardCharsets.UTF_8);
                String rewritten = new String(text, StandardCharsets.UTF_8)
                        .replace("\n/jf/", "\n/" + secret + "/jf/")
                        .replace("URI=\"/jf/", "URI=\"/" + secret + "/jf/");
                if (rewritten.startsWith("/jf/")) rewritten = "/" + secret + rewritten;
                byte[] bytes = rewritten.getBytes(StandardCharsets.UTF_8);
                keep.put("Content-Length", String.valueOf(bytes.length));
                writeStatus(out, code, reason, allowOrigin, keep);
                out.write(bytes);
                out.flush();
                return;
            }

            writeStatus(out, code, reason, allowOrigin, keep);
            if (body != null && method.equals("GET")) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = body.read(buf)) > 0) out.write(buf, 0, n);
                body.close();
            }
            out.flush();
        } finally {
            c.disconnect();
        }
    }

    private static void writeStatus(OutputStream out, int code, String reason, String allowOrigin, Map<String, String> headers) throws IOException {
        StringBuilder sb = new StringBuilder();
        sb.append("HTTP/1.1 ").append(code).append(' ').append(reason.isEmpty() ? "Status" : reason).append("\r\n");
        sb.append("Access-Control-Allow-Origin: ").append(allowOrigin).append("\r\n");
        sb.append("Access-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n");
        sb.append("Access-Control-Allow-Headers: Range, If-Range, Accept\r\n");
        sb.append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n");
        sb.append("Access-Control-Max-Age: 600\r\n");
        sb.append("Vary: Origin\r\n");
        if (headers != null) {
            for (Map.Entry<String, String> h : headers.entrySet()) sb.append(h.getKey()).append(": ").append(h.getValue()).append("\r\n");
        } else {
            sb.append("Content-Length: 0\r\n");
        }
        sb.append("Connection: close\r\n\r\n");
        out.write(sb.toString().getBytes(StandardCharsets.ISO_8859_1));
    }

    /** The request line and headers, up to the blank line; null if the client went away. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        int state = 0;
        while (buf.size() < 16 * 1024) {
            int b = in.read();
            if (b < 0) return null;
            buf.write(b);
            state = (b == '\r' && (state == 0 || state == 2)) ? state + 1 : (b == '\n' && (state == 1 || state == 3)) ? state + 1 : 0;
            if (state == 4) return buf.toString("ISO-8859-1").trim();
        }
        return null;
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[16 * 1024];
        int n;
        while ((n = in.read(buf)) > 0 && out.size() < 4 * 1024 * 1024) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }
}
