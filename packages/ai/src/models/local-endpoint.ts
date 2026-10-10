/**
 * `local-browser` custom endpoints: a model server on the USER's machine
 * (Ollama, LM Studio) that the browser calls directly — the server never does,
 * because the backend and gateway run on Cloudflare and cannot reach the
 * user's localhost (and the SSRF guard refuses it anyway, deliberately).
 *
 * The allowed hosts are exactly the ones the web app's CSP opens in
 * `connect-src` (`http://localhost:*`, `http://127.0.0.1:*`): loopback only.
 * A LAN address (`192.168.x.x`) or `*.local` name is refused — widening this
 * list without widening the CSP would save endpoints the browser then blocks,
 * and widening the CSP to the LAN would let any page script reach it.
 * IPv6 `[::1]` is left out because CSP host-sources cannot express it.
 */

/** Hostnames a `local-browser` endpoint may use — keep in step with the web CSP. */
export const LOCAL_ENDPOINT_HOSTS: ReadonlyArray<string> = ["localhost", "127.0.0.1"];

/** Default OpenAI-compatible base URLs, for placeholders and the setup guide. */
export const OLLAMA_DEFAULT_BASE_URL = "http://localhost:11434/v1";
export const LM_STUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1";

const TRAILING_V1_RE = /\/v1$/;

export const isLocalEndpointHost = (hostname: string): boolean => LOCAL_ENDPOINT_HOSTS.includes(hostname.toLowerCase());

/**
 * Validate a `local-browser` base URL. `http:` or `https:` on a loopback host,
 * any port, no credentials. Returns the normalised URL (no trailing slash, no
 * query/hash) or an error message.
 */
export const validateLocalEndpointUrl = (raw: string): { error: string } | { url: string } => {
    let parsed: URL;

    try {
        parsed = new URL(raw.trim());
    } catch {
        return { error: "Invalid URL" };
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return { error: "The endpoint must use http:// or https://" };
    }

    if (parsed.username || parsed.password) {
        return { error: "Local endpoints take no credentials in the URL" };
    }

    if (!isLocalEndpointHost(parsed.hostname)) {
        return { error: "A local endpoint must be on localhost or 127.0.0.1 — for anything else, use a public HTTPS endpoint" };
    }

    parsed.hash = "";
    parsed.search = "";

    let url = parsed.href;

    while (url.endsWith("/")) {
        url = url.slice(0, -1);
    }

    return { url };
};

/**
 * The server root of an OpenAI-compatible base URL — where Ollama's native
 * API (`/api/tags`, `/api/pull`, …) lives. `http://localhost:11434/v1` →
 * `http://localhost:11434`.
 */
export const toLocalServerRoot = (baseUrl: string): string => {
    let url = baseUrl;

    while (url.endsWith("/")) {
        url = url.slice(0, -1);
    }

    return url.replace(TRAILING_V1_RE, "");
};
