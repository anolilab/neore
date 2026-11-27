/**
 * The origin a saved site login belongs to. A fill types only into a page whose origin is exactly this string, so it is
 * normalised once, when the login is saved, and compared as a plain string afterwards: no subdomain, port or lookalike match.
 */

/** Longest origin a login may name; a real one is far shorter. */
export const SITE_ORIGIN_MAX = 255;

/** The URL parser writes every IPv4 form (decimal, hex, short) back as a dotted quad. */
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** A scheme at the very start (`https://`, `ftp://`); a `://` later on, in a path or a query, is not one. */
const LEADING_SCHEME = /^[a-z][\d+.a-z-]*:\/\//i;

/**
 * The `https://host[:port]` origin of `input`, or `null` when it is not a site a login can belong to: anything but
 * HTTPS, a URL carrying credentials, an IP address (`10.0.0.1`, and `0x7f.1`, which the URL parser reads as one), a
 * host with no dot (`localhost`, an intranet name) or one ending in a dot. The host comes back
 * lower-cased and in its ASCII (punycode) form, so a lookalike written in another script is a different origin.
 */
export const normalizeSiteOrigin = (input: string): string | null => {
    const trimmed = input.trim();
    let url: URL;

    try {
        // A bare host ("example.com", or "example.com/login?next=https://…") is read as HTTPS.
        url = new URL(LEADING_SCHEME.test(trimmed) ? trimmed : `https://${trimmed}`);
    } catch {
        return null;
    }

    if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
        return null;
    }

    const host = url.hostname;

    // A trailing dot (`example.com.`) is a different origin to the browser; refused rather than read as the dotless one.
    if (!host.includes(".") || host.endsWith(".") || host.startsWith("[") || IPV4.test(host)) {
        return null;
    }

    const origin = `https://${host}${url.port === "" ? "" : `:${url.port}`}`;

    return origin.length <= SITE_ORIGIN_MAX ? origin : null;
};

/**
 * The sign-in page `input` names for a login of `origin`, as it is stored: `undefined` for none (empty), `null` when
 * refused. A full `https://` URL with no username or password whose origin is exactly `origin` (plain string compare, as
 * everywhere: never a subdomain or another port), kept without its `#fragment`. The coming fill opens only this page.
 */
export const normalizeSignInUrl = (input: string, origin: string, maxLength: number): string | null | undefined => {
    const trimmed = input.trim();

    if (trimmed === "") {
        return undefined;
    }

    let url: URL;

    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }

    // Its own scheme, read here: `example.com:443/login` parses with the scheme `example.com`, which the origin check would
    // read as a bare host and so as HTTPS. With the scheme https, that check refuses credentials, as for a login's site.
    if (url.protocol !== "https:" || normalizeSiteOrigin(url.href) !== origin) {
        return null;
    }

    url.hash = "";

    return url.href.length <= maxLength ? url.href : null;
};
