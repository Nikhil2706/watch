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
import android.webkit.WebView;

import com.getcapacitor.Bridge;
import com.getcapacitor.WebViewListener;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.URL;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * The home shortcut: when this device is on the same network as the Mac that
 * runs the site, load the site from the Mac directly instead of through
 * Cloudflare.
 *
 * The Mac runs a small pass-through on the LAN, the "home door"
 * (scripts/home-door.mjs, port 3080), which answers GET /__watch-home with
 * {"watch":"home","site":"https://watch..."}. On launch this asks the address
 * that worked last time, and failing that every address on this device's own
 * Wi-Fi or Ethernet network (/24 around it), all at once with short timeouts.
 * An answer counts only when it names this app's own site. Found: the page is
 * reloaded from the door, and its address remembered. Not found (away from
 * home, the Mac asleep): nothing happens and the site loads through Cloudflare
 * as it always has.
 *
 * Why: on 2026-11-16 the owner's home line reached Cloudflare in Paris rather
 * than India, every request took 1-13 s, and a TV in the same flat could not
 * start an episode, while the Mac answered locally in 0.02 s.
 *
 * The door is plain http on the LAN, so it has its own cookie jar: the first
 * time, the person signs in on the door's address once. The public site's
 * sign-in is untouched and is what is used away from home.
 */
final class HomeDoor {
    private static final String TAG = "HomeDoor";
    private static final String PREFS = "home_door";
    private static final String KEY_HOST = "host";
    static final int PORT = 3080;
    static final String HELLO_PATH = "/__watch-home";

    /** The door in use, e.g. "http://192.168.1.17:3080", or null. Read by HomeDoorPlugin and RenderRecovery. */
    private static volatile String origin;

    private HomeDoor() {}

    static String origin() {
        return origin;
    }

    /** True when `url` is on the door in use. */
    static boolean isDoorUrl(String url) {
        String o = origin;
        if (o == null || url == null) return false;
        Uri a = Uri.parse(url);
        Uri b = Uri.parse(o);
        return "http".equals(a.getScheme()) && a.getHost() != null && a.getHost().equals(b.getHost()) && a.getPort() == b.getPort();
    }

    /**
     * Looks for the door in the background and, if it is found, reloads the
     * current page from it. `resumeUrl` is the page to show (after a renderer
     * recovery), or null for the start page.
     */
    static void connect(Activity activity, Bridge bridge, String resumeUrl) {
        String site = bridge.getServerUrl();
        if (site == null) return;
        new Thread(() -> {
            String found = find(activity, site);
            if (found == null) {
                Log.i(TAG, "no home door on this network; using " + site);
                return;
            }
            activity.runOnUiThread(() -> open(bridge, found, resumeUrl));
        }, "home-door").start();
    }

    private static void open(Bridge bridge, String door, String resumeUrl) {
        origin = door;
        WebView web = bridge.getWebView();
        String current = resumeUrl != null ? resumeUrl : web.getUrl();
        String path = "/";
        if (current != null) {
            Uri u = Uri.parse(current);
            if (u.getEncodedPath() != null) path = u.getEncodedPath() + (u.getEncodedQuery() != null ? "?" + u.getEncodedQuery() : "");
        }
        Log.i(TAG, "home door at " + door + "; opening " + path + " from it");
        // The public page that started loading first must not be a step Back
        // leads to: the site treats the first history entry as Home and would
        // replace the page with it, back out through Cloudflare.
        bridge.addWebViewListener(new WebViewListener() {
            private boolean cleared = false;

            @Override
            public void onPageLoaded(WebView webView) {
                if (cleared || !isDoorUrl(webView.getUrl())) return;
                cleared = true;
                webView.clearHistory();
            }

            /** The Mac went away (asleep, or this device left home): back to the public site. */
            @Override
            public void onReceivedError(WebView webView) {
                if (origin == null || !isDoorUrl(webView.getUrl())) return;
                String doorNow = origin;
                new Thread(() -> {
                    if (hello(doorNow, bridge.getServerUrl(), 1500)) return;
                    bridge.getActivity().runOnUiThread(() -> {
                        if (origin == null) return;
                        origin = null;
                        Log.i(TAG, "home door stopped answering; back to " + bridge.getServerUrl());
                        webView.loadUrl(bridge.getServerUrl());
                    });
                }, "home-door-check").start();
            }
        });
        web.loadUrl(door + path);
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

    /** Does `door` answer as this site's home door? */
    static boolean hello(String door, String site, int timeoutMs) {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(door + HELLO_PATH).openConnection();
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
