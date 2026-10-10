/**
 * Utility functions and types for tools
 */
import { toolsLogger } from "../../lib/logger";

const WWW_PREFIX_RE = /^www\./;
const TRAILING_SLASH_RE = /\/$/;
const PATTERN_RE_2 = /^0x[0-9a-f]+$/i;
const PATTERN_RE_3 = /^0[0-7]+$/;
const PATTERN_RE_4 = /^(?:0|[1-9]\d*)$/;
const PATTERN_RE_5 = /^[0-9a-fx.]+$/i;
const PATTERN_RE_6 = /^fe[89ab][0-9a-f]:/i;
const PATTERN_RE_7 = /^f[cd][0-9a-f]{2}:/i;
const PATTERN_RE_8 = /^ff[0-9a-f]{2}:/i;
const PATTERN_RE_9 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/;
/**
 * The same IPv4-mapped address after the URL parser has normalised it.
 *
 * `new URL("http://[::ffff:127.0.0.1]").hostname` is `[::ffff:7f00:1]` — WHATWG
 * rewrites the dotted-quad tail into two hex groups. `PATTERN_RE_9` only ever
 * matches a hand-written string, so without this the mapped-address check was
 * unreachable from a parsed URL and `http://[::ffff:127.0.0.1]` was treated as
 * public.
 */
const PATTERN_RE_9_HEX = /^::ffff:([\da-f]{1,4}):([\da-f]{1,4})$/;

/**
 * Retry a function with exponential backoff.
 */
export const withRetry = async <T>(
    function_: () => Promise<T>,
    options: {
        backoffMultiplier?: number;
        initialDelayMs?: number;
        maxDelayMs?: number;
        maxRetries?: number;
        shouldRetry?: (error: unknown) => boolean;
    } = {},
): Promise<T> => {
    const {
        backoffMultiplier = 2,
        initialDelayMs = 1000,
        maxDelayMs = 30_000,
        maxRetries = 3,
        shouldRetry = (error: unknown) => {
            if (error instanceof Error) {
                const message = error.message.toLowerCase();

                // Retry on rate limits, timeouts, and transient errors
                return (
                    message.includes("rate limit") ||
                    message.includes("429") ||
                    message.includes("timeout") ||
                    message.includes("econnreset") ||
                    message.includes("socket hang up") ||
                    message.includes("502") ||
                    message.includes("503") ||
                    message.includes("504")
                );
            }

            return false;
        },
    } = options;

    let lastError: unknown;
    let delay = initialDelayMs;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        try {
            return await function_();
        } catch (error) {
            lastError = error;

            if (attempt === maxRetries || !shouldRetry(error)) {
                throw error;
            }

            toolsLogger.warn(`Retry attempt ${attempt + 1}/${maxRetries} after ${delay}ms:`, error instanceof Error ? error.message : error);

            await new Promise((resolve) => {
                setTimeout(resolve, delay);
            });
            delay = Math.min(delay * backoffMultiplier, maxDelayMs);
        }
    }

    throw lastError;
};

/**
 * Extract domain from URL.
 */
export const extractDomain = (url: string): string => {
    try {
        const urlObject = new URL(url);

        return urlObject.hostname.replace(WWW_PREFIX_RE, "");
    } catch {
        return url;
    }
};

/**
 * Drop a trailing `open … close` group, plus the whitespace in front of it.
 */
const stripTrailingGroup = (value: string, open: string, close: string): string => {
    const trimmed = value.trimEnd();

    if (!trimmed.endsWith(close)) {
        return value;
    }

    const start = trimmed.lastIndexOf(open);

    return start === -1 ? value : trimmed.slice(0, start).trimEnd();
};

/**
 * Drop everything from the LAST `marker` onwards, plus the whitespace in front.
 */
const stripAfterLast = (value: string, marker: string): string => {
    const at = value.lastIndexOf(marker);

    return at === -1 ? value : value.slice(0, at).trimEnd();
};

/**
 * Clean title by removing common suffixes and brackets.
 *
 * These were four `/\s*X[^X]*Y\s*$/` regexes. A leading unanchored `\s*` restarts
 * at every offset and rescans the rest of the string, so a title padded with 50k
 * spaces cost 1.3–2.7s EACH — and titles come out of fetched HTML. Reading the
 * suffix from the end by index does the same job in one pass.
 */
export const cleanTitle = (title: string): string => {
    let result = stripTrailingGroup(title, "(", ")"); // Remove trailing parentheses

    result = stripTrailingGroup(result, "[", "]"); // Remove trailing brackets
    result = stripAfterLast(result, "-"); // Remove trailing dash content
    result = stripAfterLast(result, "|"); // Remove trailing pipe content

    return result.trim();
};

/**
 * Deduplicate results by URL.
 */
export const deduplicateByUrl = <T extends { url: string }>(results: T[]): T[] => {
    const seen = new Set<string>();

    return results.filter((item) => {
        const normalizedUrl = item.url.toLowerCase().replace(TRAILING_SLASH_RE, "");

        if (seen.has(normalizedUrl)) {
            return false;
        }

        seen.add(normalizedUrl);

        return true;
    });
};

/**
 * Deduplicate results by domain and URL.
 */
export const deduplicateByDomainAndUrl = <T extends { url: string }>(results: T[], maxPerDomain = 3): T[] => {
    const domainCounts = new Map<string, number>();
    const seen = new Set<string>();

    return results.filter((item) => {
        const normalizedUrl = item.url.toLowerCase().replace(TRAILING_SLASH_RE, "");

        if (seen.has(normalizedUrl)) {
            return false;
        }

        const domain = extractDomain(item.url);
        const count = domainCounts.get(domain) ?? 0;

        if (count >= maxPerDomain) {
            return false;
        }

        seen.add(normalizedUrl);
        domainCounts.set(domain, count + 1);

        return true;
    });
};

/**
 * Truncate text to a maximum length.
 */
export const truncateText = (text: string, maxLength: number): string => {
    if (text.length <= maxLength) {
        return text;
    }

    return `${text.slice(0, maxLength - 3)}...`;
};

/**
 * Parse JSON safely with fallback.
 */
export const safeJsonParse = <T>(json: string, fallback: T): T => {
    try {
        return JSON.parse(json) as T;
    } catch {
        return fallback;
    }
};

/**
 * Format error message consistently.
 */
export const formatError = (error: unknown): string => {
    if (error instanceof Error) {
        return error.message;
    }

    if (typeof error === "string") {
        return error;
    }

    return "An unknown error occurred";
};

/**
 * Type guard for checking if value is defined.
 */
export const isDefined = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

/**
 * Sleep for specified milliseconds.
 */
export const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Fetch with timeout AND SSRF guard. Rejects non-http(s) URLs and any URL
 * whose hostname resolves to a private/loopback/link-local/CGNAT/reserved
 * range (best-effort host-pattern check; a forward-resolving guard is not
 * available in the Worker runtime). Refuses to follow 3xx redirects by
 * default — caller must opt in via `allowRedirects: true` and is
 * responsible for re-validating the Location target.
 */
export const fetchWithTimeout = async (url: string, options?: RequestInit & { allowRedirects?: boolean }, timeoutMs = 30_000): Promise<Response> => {
    if (!isSafeUrl(url)) {
        throw new Error(`Refusing to fetch unsafe URL: ${url}`);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const { allowRedirects, ...rest } = options ?? {};

    try {
        const response = await fetch(url, {
            ...rest,
            redirect: allowRedirects ? "follow" : (rest.redirect ?? "manual"),
            // The caller's signal still aborts; it used to be overwritten by ours.
            signal: rest.signal ? AbortSignal.any([rest.signal, controller.signal]) : controller.signal,
        });

        clearTimeout(timeout);

        return response;
    } catch (error) {
        clearTimeout(timeout);

        if (error instanceof Error && error.name === "AbortError") {
            throw new Error(`Request timeout after ${timeoutMs}ms`, { cause: error });
        }

        throw error;
    }
};

/**
 * Calculate Haversine distance between two coordinates in kilometers.
 */
export const haversineDistance = (lat1: number, lon1: number, lat2: number, lon2: number): number => {
    const R = 6371; // Earth's radius in km
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

    return R * c;
};

/**
 * Parse a single IPv4 component, accepting decimal, octal (`0`-prefixed),
 * and hex (`0x`-prefixed) forms — matching `inet_aton` semantics. Returns
 * null on any malformed input so the caller can short-circuit.
 */
const parseIPv4Part = (s: string): number | null => {
    if (s.length === 0) return null;

    let n: number;

    if (PATTERN_RE_2.test(s)) {
        n = Number.parseInt(s.slice(2), 16);
    } else if (PATTERN_RE_3.test(s)) {
        n = Number.parseInt(s.slice(1), 8);
    } else if (PATTERN_RE_4.test(s)) {
        n = Number.parseInt(s, 10);
    } else {
        return null;
    }

    if (!Number.isFinite(n) || n < 0) return null;

    return n;
};

/**
 * Convert an IPv4 literal hostname to a 32-bit integer, accepting all the
 * `inet_aton`-style shorthand forms a URL parser may leave un-normalized:
 *   - 4-part dotted: a.b.c.d (each 8-bit)
 *   - 3-part: a.b.c (c is 16-bit)
 *   - 2-part: a.b (b is 24-bit)
 *   - 1-part: a (32-bit integer — e.g. 2130706433 == 127.0.0.1)
 * Each component may be decimal, octal (`0`-prefix), or hex (`0x`-prefix).
 *
 * This matters for SSRF defence: without this, `http://2130706433/`,
 * `http://0x7f000001/`, `http://0177.0.0.1/`, and bare `http://0/` all
 * resolve to loopback but bypass a dotted-quad-only check.
 */
const ipv4ToInt = (hostname: string): number | null => {
    if (!PATTERN_RE_5.test(hostname)) return null;

    const parts = hostname.split(".");

    if (parts.length === 0 || parts.length > 4) return null;

    const nums: number[] = [];

    for (const p of parts) {
        const n = parseIPv4Part(p);

        if (n === null) return null;

        nums.push(n);
    }

    let result: number;

    switch (nums.length) {
        case 1: {
            if (nums[0]! > 0xff_ff_ff_ff) return null;

            result = nums[0]!;
            break;
        }
        case 2: {
            if (nums[0]! > 0xff || nums[1]! > 0xff_ff_ff) return null;

            result = ((nums[0]! << 24) >>> 0) | nums[1]!;
            break;
        }
        case 3: {
            if (nums[0]! > 0xff || nums[1]! > 0xff || nums[2]! > 0xff_ff) return null;

            result = ((nums[0]! << 24) >>> 0) | (nums[1]! << 16) | nums[2]!;
            break;
        }
        case 4: {
            if (nums[0]! > 0xff || nums[1]! > 0xff || nums[2]! > 0xff || nums[3]! > 0xff) return null;

            result = ((nums[0]! << 24) >>> 0) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!;
            break;
        }
        default: {
            return null;
        }
    }

    return result >>> 0;
};

const isPrivateIPv4 = (n: number): boolean => {
    const inRange = (cidrStart: number, prefix: number) => {
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;

        return (n & mask) === (cidrStart & mask);
    };

    return (
        inRange(0x00_00_00_00, 8) ||
        inRange(0x0a_00_00_00, 8) ||
        inRange(0x64_40_00_00, 10) ||
        inRange(0x7f_00_00_00, 8) ||
        inRange(0xa9_fe_00_00, 16) ||
        inRange(0xac_10_00_00, 12) ||
        inRange(0xc0_00_00_00, 24) ||
        inRange(0xc0_00_02_00, 24) ||
        inRange(0xc0_a8_00_00, 16) ||
        inRange(0xc6_33_64_00, 24) ||
        inRange(0xcb_00_71_00, 24) ||
        inRange(0xe0_00_00_00, 4) ||
        inRange(0xf0_00_00_00, 4)
    );
};

/**
 * Block list of hostnames that frequently host cloud-metadata or local
 * control planes. Bracketed IPv6 forms are stripped before lookup.
 */
const BLOCKED_HOSTNAMES = new Set(["instance-data", "localhost", "metadata", "metadata.aws", "metadata.google.internal"]);

/**
 * Reject non-http(s) schemes AND host patterns that match private,
 * loopback, link-local, CGNAT, multicast, or reserved address ranges.
 *
 * This is best-effort: in the Worker runtime we cannot DNS-resolve
 * hostnames, so a malicious DNS record pointing example.com → 10.0.0.1
 * would slip through here. Callers fetching LLM-controlled URLs should
 * also rely on egress controls + redirect: 'manual' (see fetchWithTimeout).
 */
export const isSafeUrl = (url: string): boolean => {
    let parsed: URL;

    try {
        parsed = new URL(url);
    } catch {
        return false;
    }

    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return false;
    }

    let hostname = parsed.hostname.toLowerCase();

    if (hostname.endsWith(".")) hostname = hostname.slice(0, -1);

    const stripped = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

    if (BLOCKED_HOSTNAMES.has(stripped)) return false;

    // IPv4 literal — block private/reserved ranges. Accepts the inet_aton
    // shorthand forms (dotless-decimal, octal, hex) so loopback bypasses
    // like http://2130706433/ or http://0x7f000001/ are caught.
    const v4 = ipv4ToInt(stripped);

    if (v4 !== null) {
        return !isPrivateIPv4(v4);
    }

    // IPv6 literal — block loopback, link-local, ULA, multicast,
    // unspecified, and IPv4-mapped private.
    if (stripped.includes(":")) {
        const lower = stripped;

        if (lower === "::1" || lower === "::") return false;

        if (PATTERN_RE_6.test(lower)) return false;

        if (PATTERN_RE_7.test(lower)) return false;

        if (PATTERN_RE_8.test(lower)) return false;

        const mapped = lower.match(PATTERN_RE_9);

        if (mapped) {
            const m4 = ipv4ToInt(mapped[1]!);

            if (m4 !== null && isPrivateIPv4(m4)) return false;
        }

        const mappedHex = lower.match(PATTERN_RE_9_HEX);

        if (mappedHex) {
            // Two 16-bit groups, high then low, reassembled into the 32-bit
            // address they encode: `::ffff:7f00:1` -> 0x7f000001 -> 127.0.0.1.
            const high = Number.parseInt(mappedHex[1]!, 16);
            const low = Number.parseInt(mappedHex[2]!, 16);

            if (isPrivateIPv4(high * 0x1_00_00 + low)) return false;
        }
    }

    return true;
};

/**
 * Batch array into chunks.
 */
export const batchArray = <T>(array: T[], batchSize: number): T[][] => {
    const batches: T[][] = [];

    for (let i = 0; i < array.length; i += batchSize) {
        batches.push(array.slice(i, i + batchSize));
    }

    return batches;
};

/**
 * Domain allow/blocklist validation for browser navigation.
 *
 * Lives here rather than in `browser-node.ts` so it can be unit-tested: that
 * module imports `_generated/api`, which a test cannot load, so the SSRF suite
 * used to re-implement this guard and assert against the copy — passing happily
 * while the shipped guard regressed. It now imports this.
 */
/**
 * Extract the hostname from a URL string.
 */
const extractHostname = (url: string): string | null => {
    try {
        return new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
};

/**
 * Check if a domain matches an allowlist/blocklist entry.
 * Supports wildcard subdomains: "*.example.com" matches "sub.example.com".
 */
const domainMatches = (hostname: string, pattern: string): boolean => {
    const p = pattern.toLowerCase();

    if (p.startsWith("*.")) {
        const suffix = p.slice(2);

        return hostname === suffix || hostname.endsWith(`.${suffix}`);
    }

    return hostname === p;
};

/** URL schemes that are allowed for navigation */
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Validate a URL against domain allowlist/blocklist settings.
 * Returns an error message if blocked, or null if allowed.
 */
export const validateDomain = (url: string, settings?: { domainAllowlist?: string[]; domainBlocklist?: string[]; enabled?: boolean }): string | null => {
    // Block non-HTTP schemes (file://, javascript:, data:, etc.) AND
    // private/loopback/CGNAT/link-local/multicast/reserved IPs in both
    // IPv4 (incl. decimal/hex/octal encodings rejected by URL parser)
    // and IPv6 (loopback, fe80::/10, fc00::/7, ff00::/8, ::ffff:* IPv4-
    // mapped, ::, ::1). Cloud-metadata hostnames are also blocked.
    if (!isSafeUrl(url)) {
        return "URL is not allowed (private/reserved address or non-http(s) scheme)";
    }

    try {
        const parsed = new URL(url);

        if (!ALLOWED_SCHEMES.has(parsed.protocol)) {
            return `URL scheme "${parsed.protocol}" is not allowed. Only HTTP/HTTPS URLs are permitted`;
        }
    } catch {
        return "Invalid URL";
    }

    const hostname = extractHostname(url);

    if (!hostname) {
        return "Invalid URL";
    }

    if (!settings) {
        return null;
    }

    // Check if browser is disabled for this user
    if (settings.enabled === false) {
        return "Browser automation is disabled in your settings";
    }

    // If allowlist is set, only those domains are permitted
    if (settings.domainAllowlist && settings.domainAllowlist.length > 0) {
        const allowed = settings.domainAllowlist.some((pattern) => domainMatches(hostname, pattern));

        if (!allowed) {
            return `Domain "${hostname}" is not in your allowed domains list`;
        }
    }

    // Check blocklist
    if (settings.domainBlocklist && settings.domainBlocklist.length > 0) {
        const blocked = settings.domainBlocklist.some((pattern) => domainMatches(hostname, pattern));

        if (blocked) {
            return `Domain "${hostname}" is blocked by your settings`;
        }
    }

    return null;
};
