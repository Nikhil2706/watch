package com.abhigyanverma.watch;

import android.net.Uri;

import com.getcapacitor.Plugin;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Keeps links inside the app while it is on the home door (HomeDoor).
 *
 * Capacitor opens any link to an address other than the configured site in
 * the system browser, and the door's address (http://192.168.x.y:3080) is not
 * the configured site, so every link clicked on the door's pages would have
 * left the app. Plugins are asked first; this says "load it here" for the
 * door in use and has no opinion about anything else. Nothing is exposed to
 * the page.
 *
 * Not done with Capacitor's allowNavigation instead: those entries also
 * become origin rules for its script injection, where a wildcard IP address
 * is not a valid rule.
 */
@CapacitorPlugin(name = "HomeDoor")
public class HomeDoorPlugin extends Plugin {
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        return HomeDoor.isDoorUrl(url.toString()) ? Boolean.FALSE : null;
    }
}
