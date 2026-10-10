/**
 * The endpoint is a URL the BROWSER gave us, so it is attacker-influenced, and
 * every later send POSTs to it. `@lunora/notify` only refuses private hosts
 * (its exact-origin `allowedPushOrigins` cannot express the per-region WNS
 * hosts), so {@link isAllowedPushEndpoint} admits only https URLs on the push
 * services the browsers actually use. Anything else would turn the push sender
 * into an SSRF primitive.
 */

/**
 * Hosts of the push services browsers hand out endpoints for: Chromium (FCM),
 * Firefox (Mozilla autopush), Edge/Windows (WNS) and Safari (Apple).
 *
 * Google is listed by EXACT host: `googleapis.com` fronts every Google API
 * (`storage.googleapis.com/<bucket>/…` included), so a suffix would let a
 * browser-supplied endpoint aim VAPID-signed POSTs at any of them. A suffix is
 * kept only where the whole domain is the push service — WNS hands out
 * per-region hosts (`wns2-par02p.notify.windows.com`).
 */
const PUSH_HOST_SUFFIXES = [".push.services.mozilla.com", ".notify.windows.com", ".push.apple.com"] as const;
const PUSH_HOSTS = new Set(["android.googleapis.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);

export const isAllowedPushEndpoint = (endpoint: string): boolean => {
    let url: URL;

    try {
        url = new URL(endpoint);
    } catch {
        return false;
    }

    if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.port !== "") {
        return false;
    }

    const host = url.hostname.toLowerCase();

    return PUSH_HOSTS.has(host) || PUSH_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
};
