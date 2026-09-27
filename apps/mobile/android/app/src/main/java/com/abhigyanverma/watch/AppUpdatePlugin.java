package com.abhigyanverma.watch;

import android.app.Activity;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Updates, from the page: window.Capacitor.Plugins.AppUpdate.
 *
 * The launch prompt (UpdateChecker) is easy to wave away and then gone, so
 * the site's ⋯ menu shows the app's version and offers the update whenever
 * there is one. The work stays in UpdateChecker; this only exposes it. See
 * src/lib/app-update.ts for the web side.
 */
@CapacitorPlugin(name = "AppUpdate")
public class AppUpdatePlugin extends Plugin {

    /** { current: {code, name}, latest: {code, name} | null, available, dev } */
    @PluginMethod
    public void status(PluginCall call) {
        new Thread(() -> {
            JSObject out = new JSObject();
            boolean dev = UpdateChecker.isDevBuild(getContext());
            out.put("dev", dev);
            int current = 0;
            try {
                current = UpdateChecker.currentCode(getContext());
            } catch (Exception ignored) {
            }
            JSObject cur = new JSObject();
            cur.put("code", current);
            cur.put("name", UpdateChecker.currentName(getContext()));
            out.put("current", cur);

            boolean available = false;
            try {
                UpdateChecker.Release latest = UpdateChecker.fetchLatest();
                JSObject l = new JSObject();
                l.put("code", latest.code);
                l.put("name", latest.name);
                out.put("latest", l);
                available = !dev && latest.code > current;
            } catch (Exception e) {
                // Offline or GitHub unreachable: say so by leaving latest null.
                out.put("latest", null);
            }
            out.put("available", available);
            call.resolve(out);
        }, "update-status").start();
    }

    /** Downloads the newest release and opens the installer. Resolves {started, reason?}. */
    @PluginMethod
    public void update(PluginCall call) {
        final Activity activity = getActivity();
        if (UpdateChecker.isDevBuild(activity)) {
            JSObject out = new JSObject();
            out.put("started", false);
            out.put("reason", "dev");
            call.resolve(out);
            return;
        }
        new Thread(() -> {
            JSObject out = new JSObject();
            try {
                UpdateChecker.Release latest = UpdateChecker.fetchLatest();
                if (latest.code <= UpdateChecker.currentCode(activity)) {
                    out.put("started", false);
                    out.put("reason", "up-to-date");
                    call.resolve(out);
                    return;
                }
                activity.runOnUiThread(() -> UpdateChecker.startUpdate(activity, latest.apkUrl));
                out.put("started", true);
                call.resolve(out);
            } catch (Exception e) {
                call.reject("Could not reach the update server.");
            }
        }, "update-start").start();
    }
}
