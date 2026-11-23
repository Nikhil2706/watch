package com.abhigyanverma.watch;

import android.app.Activity;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.Uri;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;

import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.FilterInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URL;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The home shortcut: on the same network as the Mac that runs the site, the
 * site's pages, images and video come from the Mac directly instead of
 * through Cloudflare.
 *
 * The Mac runs a small pass-through on the LAN, the "home door"
 * (scripts/home-door.mjs, port 3080), which answers GET /__watch-home with
 * {"watch":"home","site":"https://watch..."}. On launch this asks the address
 * that worked last time, and failing that every address on this device's own
 * Wi-Fi or Ethernet network (/24 around it), all at once with short timeouts.
 * An answer counts only when it names this app's own site.
 *
 * The app does NOT move to the door's address. It stays on the site's own
 * https address, and its WebViewClient answers that address's GET requests by
 * fetching the same path from the door. So the page, its cookies and
 * Capacitor's bridge (which Capacitor attaches only to the site's address:
 * in-app updates, offline downloads, "you are in the app") are exactly as
 * they are away from home; only where the bytes come from changes. The first
 * version (1.8.22) loaded the door's own http address instead, and the site
 * then thought it was in a browser and offered to install the app.
 *
 * Left to the network, through Cloudflare as always: anything that is not a
 * GET (a request body cannot be read here), live event streams, Capacitor's
 * own paths, and any answer that is a redirect (a WebView cannot be handed
 * one). If the door stops answering, everything goes back to the network.
 *
 * Video is not handed over here at all: a Vu TV's WebView would not play it
 * that way. It comes from MediaRelay, a small server on 127.0.0.1 the page's
 * player is pointed at (window.__watchMediaBase), which fetches from the door.
 *
 * Why: on 2026-11-16 the owner's home line reached Cloudflare in Paris rather
 * than India, every request took 1-13 s, and a TV in the same flat could not
 * start an episode, while the Mac answered locally in 0.02 s.
 */
final class HomeDoor {
    private static final String TAG = "HomeDoor";
    private static final String PREFS = "home_door";
    private static final String KEY_HOST = "host";
    static final int PORT = 3080;
    static final String HELLO_PATH = "/__watch-home";

    /** The door in use, e.g. "http://192.168.1.17:3080", or null when the network is used. */
    private static volatile String door;

    private HomeDoor() {}

    /** Counted down once the first search for the door is over, found or not. */
    private static final java.util.concurrent.CountDownLatch searched = new java.util.concurrent.CountDownLatch(1);

    /**
     * The door's origin, waiting up to `waitMs` for the launch search to
     * finish; null when there is none. For UpdateChecker, which runs at launch
     * alongside the search. Never on the UI thread.
     */
    static String door(long waitMs) {
        try {
            searched.await(waitMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return door;
    }

    /**
     * Puts the request handler in place and looks for the door in the
     * background. When it is found, the open page is reloaded so it too comes
     * from the door.
     */
    static void install(Activity activity, Bridge bridge) {
        String site = bridge.getServerUrl();
        if (site == null) return;
        bridge.setWebViewClient(new Client(bridge, site));
        new Thread(() -> {
            String found = find(activity, site);
            if (found != null) door = found;
            searched.countDown();
            if (found == null) {
                Log.i(TAG, "no home door on this network; using " + site);
                return;
            }
            door = found;
            Log.i(TAG, "home door at " + found + "; the site's requests now come from it");
            String relayBase = null;
            try {
                relayBase = new MediaRelay(site, () -> door).start();
            } catch (Exception e) {
                Log.w(TAG, "video relay did not start; video goes through the network", e);
            }
            final String base = relayBase;
            activity.runOnUiThread(() -> {
                // The site's player loads video from the relay when this is set
                // (src/lib/media-relay.ts). Only on the site's own origin.
                if (base != null && WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                    try {
                        WebViewCompat.addDocumentStartJavaScript(
                            bridge.getWebView(),
                            "window.__watchMediaBase=" + org.json.JSONObject.quote(base) + ";",
                            Collections.singleton(site.replaceAll("/+$", "")));
                        Log.i(TAG, "video comes through the relay at 127.0.0.1");
                    } catch (Exception e) {
                        Log.w(TAG, "could not tell the page about the video relay", e);
                    }
                }
                bridge.getWebView().reload();
            });
        }, "home-door").start();
    }

    /** Capacitor's client, with the site's GET requests answered from the door while there is one. */
    static final class Client extends BridgeWebViewClient {
        private final Bridge bridge;
        private final Uri site;

        Client(Bridge bridge, String site) {
            super(bridge);
            this.bridge = bridge;
            this.site = Uri.parse(site);
        }

        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            String d = door;
            if (d != null && fromDoor(request)) {
                WebResourceResponse r = fetch(d, request);
                if (r != null) return r;
            }
            return super.shouldInterceptRequest(view, request);
        }

        private boolean fromDoor(WebResourceRequest request) {
            if (!"GET".equalsIgnoreCase(request.getMethod())) return false;
            Uri u = request.getUrl();
            if (!"https".equals(u.getScheme()) || u.getHost() == null || !u.getHost().equals(site.getHost())) return false;
            String path = u.getPath() == null ? "/" : u.getPath();
            if (path.startsWith("/_capacitor")) return false;
            // Video is not handed over from here: a TV's WebView would not play it
            // (whole or in pieces). It goes through MediaRelay, or the network.
            if (header(request.getRequestHeaders(), "Range") != null) return false;
            String lower = path.toLowerCase(Locale.ROOT);
            if (lower.startsWith("/jf/videos/") || lower.startsWith("/jf/audio/")) return false;
            String accept = header(request.getRequestHeaders(), "Accept");
            // Live event streams stay open for the whole visit; leave them to the network.
            return accept == null || !accept.contains("text/event-stream");
        }

        /** The response from the door, or null to let the network answer instead. */
        private WebResourceResponse fetch(String d, WebResourceRequest request) {
            Uri u = request.getUrl();
            String path = (u.getEncodedPath() == null ? "/" : u.getEncodedPath()) + (u.getEncodedQuery() == null ? "" : "?" + u.getEncodedQuery());
            String siteUrl = site.getScheme() + "://" + site.getAuthority();
            HttpURLConnection c = null;
            try {
                c = (HttpURLConnection) new URL(d + path).openConnection();
                c.setInstanceFollowRedirects(false);
                c.setConnectTimeout(1500);
                // Video is read as the viewer watches; a long gap is someone paused, not a dead door.
                c.setReadTimeout(60_000);
                c.setUseCaches(false);
                for (Map.Entry<String, String> h : request.getRequestHeaders().entrySet()) {
                    String name = h.getKey().toLowerCase(Locale.ROOT);
                    // A 304 cannot be handed to a WebView, so never ask for one.
                    if (name.equals("if-none-match") || name.equals("if-modified-since") || name.equals("host")) continue;
                    // A response handed back here must already be decoded. Left to
                    // itself, HttpURLConnection asks for gzip and unpacks it; passing
                    // the page's own Accept-Encoding on would hand back raw bytes.
                    if (name.equals("accept-encoding")) continue;
                    c.setRequestProperty(h.getKey(), h.getValue());
                }
                String cookies = CookieManager.getInstance().getCookie(siteUrl);
                if (cookies != null) c.setRequestProperty("Cookie", cookies);
                if (header(request.getRequestHeaders(), "User-Agent") == null) {
                    c.setRequestProperty("User-Agent", bridge.getWebView().getSettings().getUserAgentString());
                }

                int code = c.getResponseCode();
                if (code < 200 || (code >= 300 && code < 400) || code > 599) {
                    // A redirect cannot be passed on; the network will ask again and follow it.
                    c.disconnect();
                    return null;
                }

                Map<String, String> headers = new HashMap<>();
                for (Map.Entry<String, List<String>> h : c.getHeaderFields().entrySet()) {
                    if (h.getKey() == null || h.getValue() == null) continue;
                    String name = h.getKey();
                    if (name.equalsIgnoreCase("set-cookie")) {
                        // The door takes Secure off for plain http; on the site's
                        // https address it goes back on.
                        for (String cookie : h.getValue()) CookieManager.getInstance().setCookie(siteUrl, cookie + "; Secure");
                        continue;
                    }
                    headers.put(name, String.join(", ", h.getValue()));
                }

                String type = c.getContentType();
                String mime = "application/octet-stream";
                String charset = null;
                if (type != null) {
                    String[] parts = type.split(";");
                    mime = parts[0].trim();
                    for (String p : parts) {
                        String t = p.trim();
                        if (t.toLowerCase(Locale.ROOT).startsWith("charset=")) charset = t.substring(8).replace("\"", "");
                    }
                }
                String reason = c.getResponseMessage();
                if (reason == null || reason.isEmpty()) reason = code < 400 ? "OK" : "Error";
                InputStream body = code >= 400 ? c.getErrorStream() : c.getInputStream();
                if (body == null) body = new ByteArrayInputStream(new byte[0]);
                final HttpURLConnection conn = c;
                InputStream closing = new FilterInputStream(body) {
                    @Override
                    public void close() throws IOException {
                        try {
                            super.close();
                        } finally {
                            conn.disconnect();
                        }
                    }
                };
                return new WebResourceResponse(mime, charset, code, reason, headers, closing);
            } catch (IOException e) {
                if (c != null) c.disconnect();
                checkStillThere(d);
                return null;
            } catch (RuntimeException e) {
                if (c != null) c.disconnect();
                Log.w(TAG, "could not pass " + path + " through the home door", e);
                return null;
            }
        }

        private void checkStillThere(String d) {
            new Thread(() -> {
                if (door == null || hello(d, site.toString(), 1500)) return;
                if (d.equals(door)) {
                    door = null;
                    Log.i(TAG, "home door stopped answering; back to " + site);
                }
            }, "home-door-check").start();
        }
    }

    private static String header(Map<String, String> headers, String name) {
        for (Map.Entry<String, String> h : headers.entrySet()) {
            if (h.getKey().equalsIgnoreCase(name)) return h.getValue();
        }
        return null;
    }

    /** The door's origin, or null. Blocking; never on the UI thread. */
    static String find(Context context, String site) {
        Inet4Address self = localAddress(context);
        if (self == null) return null;
        SharedPreferences prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);

        String last = prefs.getString(KEY_HOST, null);
        if (last != null && hello("http://" + last + ":" + PORT, site, 800)) return "http://" + last + ":" + PORT;

        byte[] b = self.getAddress();
        List<String> hosts = new ArrayList<>();
        for (int i = 1; i < 255; i++) {
            if (i == (b[3] & 0xff)) continue;
            hosts.add((b[0] & 0xff) + "." + (b[1] & 0xff) + "." + (b[2] & 0xff) + "." + i);
        }
        AtomicReference<String> hit = new AtomicReference<>();
        ExecutorService pool = Executors.newFixedThreadPool(48);
        for (String host : hosts) {
            pool.execute(() -> {
                if (hit.get() != null) return;
                if (hello("http://" + host + ":" + PORT, site, 400)) hit.compareAndSet(null, host);
            });
        }
        pool.shutdown();
        try {
            pool.awaitTermination(4, TimeUnit.SECONDS);
        } catch (InterruptedException ignored) {
            Thread.currentThread().interrupt();
        }
        pool.shutdownNow();
        String host = hit.get();
        if (host == null) return null;
        prefs.edit().putString(KEY_HOST, host).apply();
        return "http://" + host + ":" + PORT;
    }

    /** Does `d` answer as this site's home door? */
    static boolean hello(String d, String site, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(d + HELLO_PATH).openConnection();
            c.setConnectTimeout(timeoutMs);
            c.setReadTimeout(timeoutMs + 400);
            c.setInstanceFollowRedirects(false);
            if (c.getResponseCode() != 200) return false;
            String body;
            try (InputStream in = c.getInputStream()) {
                ByteArrayOutputStream out = new ByteArrayOutputStream();
                byte[] buf = new byte[512];
                int n;
                while ((n = in.read(buf)) > 0 && out.size() < 4096) out.write(buf, 0, n);
                body = out.toString("UTF-8");
            }
            String want = site.replaceAll("/+$", "");
            return body.contains("\"watch\":\"home\"") && body.contains("\"site\":\"" + want + "\"");
        } catch (Exception e) {
            return false;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    /** This device's IPv4 address on Wi-Fi or Ethernet, or null (mobile data, no network). */
    private static Inet4Address localAddress(Context context) {
        try {
            ConnectivityManager cm = (ConnectivityManager) context.getSystemService(Context.CONNECTIVITY_SERVICE);
            Network net = cm.getActiveNetwork();
            if (net == null) return null;
            NetworkCapabilities caps = cm.getNetworkCapabilities(net);
            if (caps == null
                || !(caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) || caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET))) {
                return null;
            }
            LinkProperties lp = cm.getLinkProperties(net);
            if (lp == null) return null;
            for (LinkAddress la : lp.getLinkAddresses()) {
                InetAddress a = la.getAddress();
                if (a instanceof Inet4Address && a.isSiteLocalAddress()) return (Inet4Address) a;
            }
        } catch (Exception e) {
            Log.w(TAG, "could not read the network address", e);
        }
        return null;
    }
}
