/**
 * The user's web-search domain blocklist, as pure functions. The settings write
 * (`auth/functions.ts`) normalises with them and the web search tool enforces
 * them; pinned by `search-domains.test.ts`.
 *
 * A blocked host blocks its subdomains too: `example.com` removes
 * `www.example.com` and `docs.example.com` results.
 */

/** Entries the user may keep. Each one is a hostname, so this is generous. */
export const MAX_SEARCH_DOMAIN_BLOCKLIST = 100;

/** A registrable-looking hostname: labels of letters, digits and hyphens, ending in a letter-only TLD. */
const HOSTNAME_RE = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;
const TRAILING_DOT_RE = /\.$/;
const WWW_PREFIX_RE = /^www\./;

/**
 * Reads a typed entry (`example.com`, `https://Example.com/path`,
 * `www.example.com`) as a bare lowercase hostname, without `www.` (which the
 * blocklist covers already). `undefined` when it is not a hostname.
 */
export const toSearchDomain = (entry: string): string | undefined => {
    const trimmed = entry.trim();

    if (trimmed === "") {
        return undefined;
    }

    let host: string;

    try {
        host = new URL(SCHEME_RE.test(trimmed) ? trimmed : `https://${trimmed}`).hostname;
    } catch {
        return undefined;
    }

    const normalised = host.toLowerCase().replace(TRAILING_DOT_RE, "").replace(WWW_PREFIX_RE, "");

    return HOSTNAME_RE.test(normalised) ? normalised : undefined;
};

/**
 * Normalises what the user typed (one entry per line). Blank lines drop; entries
 * that are not hostnames come back in `invalid` for the caller to reject.
 */
export const normalizeSearchDomainBlocklist = (entries: ReadonlyArray<string>): { domains: string[]; invalid: string[] } => {
    const domains = new Set<string>();
    const invalid: string[] = [];

    for (const entry of entries) {
        if (entry.trim() === "") {
            continue;
        }

        const domain = toSearchDomain(entry);

        if (domain) {
            domains.add(domain);
        } else {
            invalid.push(entry.trim());
        }
    }

    return { domains: [...domains], invalid };
};

/** The hostname of a result URL, lowercase, or `undefined` when it does not parse. */
export const hostOfUrl = (url: string): string | undefined => {
    try {
        return new URL(url).hostname.toLowerCase().replace(TRAILING_DOT_RE, "");
    } catch {
        return undefined;
    }
};

/** True when `host` is a blocked domain or one of its subdomains. */
export const isBlockedSearchHost = (host: string, blocklist: ReadonlyArray<string>): boolean =>
    blocklist.some((domain) => host === domain || host.endsWith(`.${domain}`));

/**
 * Drops results whose host is blocked. A result whose URL does not parse is
 * dropped too: it cannot be shown to be outside the blocklist.
 */
export const filterBlockedResults = <T extends { url: string }>(results: ReadonlyArray<T>, blocklist: ReadonlyArray<string>): T[] => {
    if (blocklist.length === 0) {
        return [...results];
    }

    return results.filter((result) => {
        const host = hostOfUrl(result.url);

        return host !== undefined && !isBlockedSearchHost(host, blocklist);
    });
};

/**
 * The provider's `exclude_domains`: the model's own excludes plus the user's
 * whole blocklist, so the provider filters what it can and the post-filter
 * catches what it ignores.
 */
export const mergeExcludeDomains = (modelExclude: ReadonlyArray<string> | undefined, blocklist: ReadonlyArray<string>): string[] => [
    ...new Set([...(modelExclude ?? []), ...blocklist]),
];

/**
 * The model's `include_domains` with blocked entries removed. Entries that are
 * not hostnames stay as the model sent them, as before. When the caller asked
 * for includes and every one was blocked, the result is empty, and the caller
 * must not search: an empty include list would search the whole web.
 */
export const filterIncludeDomains = (modelInclude: ReadonlyArray<string>, blocklist: ReadonlyArray<string>): string[] =>
    modelInclude.filter((entry) => {
        const domain = toSearchDomain(entry);

        return domain === undefined || !isBlockedSearchHost(domain, blocklist);
    });
