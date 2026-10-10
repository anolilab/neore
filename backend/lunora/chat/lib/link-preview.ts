/**
 * Link preview cards for URLs in chat messages (`chat/link-preview.ts`).
 *
 * Pure except for the injected fetchers, so the URL rules, the HTML meta parser
 * and the fetch orchestration are unit-tested without the runtime.
 *
 * Security shape, because the URL is whatever a message contains:
 *
 * - The generic page fetch goes through `fetchWithTimeout` (SSRF guard,
 *   `redirect: "manual"`), and every redirect hop is re-validated with
 *   `validateDomain` before it is followed — never an auto-follow.
 * - `fetchWithTimeout`'s deadline stops at the response HEADERS, so the body
 *   read has its own deadline and byte cap ({@link readCappedText}); a slow or
 *   endless body cannot hold the action.
 * - Every body this opens is consumed or cancelled, on success and failure
 *   alike (a leaked body kills local `wrangler dev`; see CLAUDE.md).
 * - Linear issues are NOT fetched: their pages sit behind sign-in, so a fetch
 *   returns the login page's metadata. The card is built from the URL alone.
 */

/** Total time budget for one preview, headers and body together. */
export const LINK_PREVIEW_TIMEOUT_MS = 5000;

/** At most this much HTML is read; `<head>` metadata sits well inside it. */
export const MAX_HTML_BYTES = 256 * 1024;

/** Redirect hops followed (each re-validated) before giving up. */
export const MAX_REDIRECTS = 4;

export const MAX_PREVIEW_URL_LENGTH = 2048;

const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 300;
const MAX_SITE_NAME_CHARS = 80;

export const LINK_PREVIEW_CACHE_NAME = "linkPreview";

/** A found preview is good for a day. */
export const LINK_PREVIEW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** A failed one is retried after half an hour, so a blip does not stick. */
export const LINK_PREVIEW_NEGATIVE_TTL_MS = 30 * 60 * 1000;

export type LinkPreviewKind = "generic" | "github-issue" | "github-pull" | "github-repo" | "linear-issue";

export interface GithubPreviewInfo {
    language?: string;
    number?: number;
    owner: string;
    repo: string;
    stars?: number;
    /** `open` / `closed` / `merged` / `draft`, for issues and pull requests. */
    state?: string;
}

export interface LinkPreview {
    description?: string;
    favicon?: string;
    github?: GithubPreviewInfo;
    image?: string;
    kind: LinkPreviewKind;
    linear?: { identifier: string };
    ok: boolean;
    siteName?: string;
    title?: string;
    url: string;
}

export type UrlTarget =
    | { kind: "generic" }
    | { kind: "github-issue" | "github-pull"; number: number; owner: string; repo: string }
    | { kind: "github-repo"; owner: string; repo: string }
    | { identifier: string; kind: "linear-issue"; titleFromSlug?: string };

/**
 * The canonical form a URL is previewed and cached under, or `null` when it is
 * not previewable: not http(s), carries credentials, or is too long. The
 * fragment is dropped — it never changes what the server returns.
 */
export const normalizePreviewUrl = (raw: string): string | null => {
    if (raw.length > MAX_PREVIEW_URL_LENGTH) {
        return null;
    }

    let parsed: URL;

    try {
        parsed = new URL(raw.trim());
    } catch {
        return null;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return null;
    }

    if (parsed.username || parsed.password || !parsed.hostname) {
        return null;
    }

    parsed.hash = "";

    return parsed.href;
};

/** First-level GitHub paths that are site pages, not owners. */
const GITHUB_RESERVED_OWNERS = new Set([
    "about",
    "apps",
    "collections",
    "enterprise",
    "explore",
    "features",
    "login",
    "marketplace",
    "notifications",
    "orgs",
    "pricing",
    "search",
    "settings",
    "sponsors",
    "topics",
    "trending",
]);

const GITHUB_NAME_RE = /^[\w.-]{1,100}$/u;
const ISSUE_NUMBER_RE = /^\d{1,9}$/u;
const LINEAR_IDENTIFIER_RE = /^[a-z][a-z\d]{0,9}-\d{1,9}$/iu;
const GIT_SUFFIX_RE = /\.git$/u;
const SLUG_SEPARATOR_RE = /[-_]+/gu;

const titleFromSlug = (slug: string | undefined): string | undefined => {
    if (!slug) {
        return undefined;
    }

    let decoded: string;

    try {
        decoded = decodeURIComponent(slug);
    } catch {
        return undefined;
    }

    const words = decoded.replaceAll(SLUG_SEPARATOR_RE, " ").trim();

    if (!words) {
        return undefined;
    }

    return truncate(words.charAt(0).toUpperCase() + words.slice(1), MAX_TITLE_CHARS);
};

/** Which kind of card a (normalized) URL gets. */
export const classifyUrl = (url: string): UrlTarget => {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (host === "github.com" || host === "www.github.com") {
        const [owner, rawRepo, section, number] = segments;
        const repo = rawRepo?.replace(GIT_SUFFIX_RE, "");

        if (!owner || !repo || GITHUB_RESERVED_OWNERS.has(owner.toLowerCase()) || !GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
            return { kind: "generic" };
        }

        if (section === undefined) {
            return { kind: "github-repo", owner, repo };
        }

        if (number !== undefined && (section === "issues" || section === "pull") && ISSUE_NUMBER_RE.test(number)) {
            return { kind: section === "pull" ? "github-pull" : "github-issue", number: Number(number), owner, repo };
        }

        return { kind: "generic" };
    }

    if (host === "linear.app") {
        const [, section, identifier, slug] = segments;

        if (section === "issue" && identifier && LINEAR_IDENTIFIER_RE.test(identifier)) {
            return { identifier: identifier.toUpperCase(), kind: "linear-issue", titleFromSlug: titleFromSlug(slug) };
        }
    }

    return { kind: "generic" };
};

// ---------------------------------------------------------------------------
// HTML metadata
// ---------------------------------------------------------------------------

// The attribute run is bounded, so a `<meta` with no closing `>` cannot make
// every later match rescan the rest of the document.
const TAG_RE = /<(meta|link)\b([^>]{0,4096})>/giu;
const ATTRIBUTE_NAME_CHAR_RE = /[\w:-]/u;
const SPACE_CHAR_RE = /\s/u;
const TITLE_RE = /<title\b[^>]*>([\s\S]*?)<\/title>/iu;
const WHITESPACE_RE = /\s+/gu;
const ENTITY_RE = /&(#x[\da-f]+|#\d+|[a-z]+);/giu;

const NAMED_ENTITIES: Record<string, string> = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };

export const decodeHtmlEntities = (text: string): string =>
    text.replaceAll(ENTITY_RE, (match, entity: string) => {
        const lower = entity.toLowerCase();

        if (lower.startsWith("#x") || lower.startsWith("#")) {
            const code = lower.startsWith("#x") ? Number.parseInt(lower.slice(2), 16) : Number.parseInt(lower.slice(1), 10);

            // Out-of-range and surrogate code points would throw or make garbage.
            return Number.isSafeInteger(code) && code > 0 && code <= 0x10_ff_ff && (code < 0xd8_00 || code > 0xdf_ff) ? String.fromCodePoint(code) : match;
        }

        return NAMED_ENTITIES[lower] ?? match;
    });

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

const clean = (value: string | undefined, max: number): string | undefined => {
    if (value === undefined) {
        return undefined;
    }

    const text = decodeHtmlEntities(value).replaceAll(WHITESPACE_RE, " ").trim();

    return text ? truncate(text, max) : undefined;
};

/**
 * `name="value"` pairs of one tag, first occurrence wins. A hand-written,
 * single-pass scanner rather than a regex: an attribute regex over hostile
 * markup backtracks super-linearly, and this runs on arbitrary pages.
 */
const parseAttributes = (source: string): Map<string, string> => {
    const attributes = new Map<string, string>();
    const { length } = source;
    let index = 0;

    const skip = (test: (character: string) => boolean): void => {
        while (index < length && test(source.charAt(index))) {
            index += 1;
        }
    };

    while (index < length) {
        skip((character) => !ATTRIBUTE_NAME_CHAR_RE.test(character));

        const nameStart = index;

        skip((character) => ATTRIBUTE_NAME_CHAR_RE.test(character));

        const name = source.slice(nameStart, index).toLowerCase();

        skip((character) => SPACE_CHAR_RE.test(character));

        if (source.charAt(index) !== "=") {
            continue;
        }

        index += 1;
        skip((character) => SPACE_CHAR_RE.test(character));

        const quote = source.charAt(index);
        let value: string;

        if (quote === '"' || quote === "'") {
            const close = source.indexOf(quote, index + 1);
            const end = close === -1 ? length : close;

            value = source.slice(index + 1, end);
            index = end + 1;
        } else {
            const valueStart = index;

            skip((character) => !SPACE_CHAR_RE.test(character));
            value = source.slice(valueStart, index);
        }

        if (name && !attributes.has(name)) {
            attributes.set(name, value);
        }
    }

    return attributes;
};

/**
 * An absolute https URL for an image the BROWSER will load, or `undefined`.
 * Plain http is dropped (mixed content), as is anything that is not a URL.
 */
const resolveImageUrl = (value: string | undefined, baseUrl: string): string | undefined => {
    if (!value) {
        return undefined;
    }

    try {
        const resolved = new URL(decodeHtmlEntities(value.trim()), baseUrl);

        return resolved.protocol === "https:" && resolved.href.length <= MAX_PREVIEW_URL_LENGTH ? resolved.href : undefined;
    } catch {
        return undefined;
    }
};

export interface HtmlMeta {
    description?: string;
    favicon?: string;
    image?: string;
    siteName?: string;
    title?: string;
}

/**
 * OpenGraph / Twitter card / plain `<title>` metadata from an HTML document.
 * Regex over the (capped) text rather than a DOM: Workers have no DOMParser,
 * and only a handful of head tags matter.
 */
export const parseHtmlMeta = (html: string, baseUrl: string): HtmlMeta => {
    const meta = new Map<string, string>();
    let favicon: string | undefined;

    for (const match of html.matchAll(TAG_RE)) {
        const attributes = parseAttributes(match[2] ?? "");

        if (match[1]?.toLowerCase() === "meta") {
            const key = (attributes.get("property") ?? attributes.get("name"))?.toLowerCase();
            const content = attributes.get("content");

            if (key && content !== undefined && !meta.has(key)) {
                meta.set(key, content);
            }

            continue;
        }

        const relations = attributes.get("rel")?.toLowerCase().split(WHITESPACE_RE) ?? [];

        if (favicon === undefined && (relations.includes("icon") || relations.includes("apple-touch-icon"))) {
            favicon = resolveImageUrl(attributes.get("href"), baseUrl);
        }
    }

    const titleTag = TITLE_RE.exec(html)?.[1];

    return {
        description: clean(meta.get("og:description") ?? meta.get("twitter:description") ?? meta.get("description"), MAX_DESCRIPTION_CHARS),
        favicon,
        image: resolveImageUrl(meta.get("og:image") ?? meta.get("og:image:url") ?? meta.get("twitter:image"), baseUrl),
        siteName: clean(meta.get("og:site_name") ?? meta.get("application-name"), MAX_SITE_NAME_CHARS),
        title: clean(meta.get("og:title") ?? meta.get("twitter:title") ?? titleTag, MAX_TITLE_CHARS),
    };
};

// ---------------------------------------------------------------------------
// Fetching
// ---------------------------------------------------------------------------

/**
 * Reads at most `maxBytes` of a body as UTF-8 text within `timeoutMs`, then
 * cancels the rest. Always leaves the body consumed or cancelled.
 */
export const readCappedText = async (response: Response, maxBytes: number, timeoutMs: number): Promise<string> => {
    const { body } = response;

    if (!body) {
        return "";
    }

    const reader = body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"timeout">((resolve) => {
        timer = setTimeout(resolve, Math.max(0, timeoutMs), "timeout");
    });

    try {
        while (total < maxBytes) {
            const next = await Promise.race([reader.read(), deadline]);

            if (next === "timeout" || next.done) {
                break;
            }

            chunks.push(next.value);
            total += next.value.byteLength;
        }
    } finally {
        clearTimeout(timer);
        // Past the cap, on the deadline or at the end alike: nothing is left open.
        await reader.cancel().catch(() => undefined);
    }

    const bytes = new Uint8Array(Math.min(total, maxBytes));
    let offset = 0;

    for (const chunk of chunks) {
        const room = bytes.length - offset;

        if (room <= 0) {
            break;
        }

        bytes.set(chunk.subarray(0, room), offset);
        offset += Math.min(room, chunk.byteLength);
    }

    return new TextDecoder("utf-8").decode(bytes);
};

export interface LinkPreviewDependencies {
    /** Calls to hosts WE chose (the GitHub REST API); must carry its own deadline. */
    fetchApi: (url: string, init: RequestInit & { timeoutMs: number }) => Promise<Response>;
    /** SSRF-guarded fetch of a user-supplied URL, `redirect: "manual"` (`fetchWithTimeout`). */
    fetchPage: (url: string, init: RequestInit, timeoutMs: number) => Promise<Response>;
    now: () => number;
    /** `validateDomain`: an error message, or `null` when the URL may be fetched. */
    validateUrl: (url: string) => string | null;
}

const USER_AGENT = "NeoreLinkPreview/1.0 (+https://neore.chat)";

const failed = (url: string, kind: LinkPreviewKind = "generic"): LinkPreview => {
    return { kind, ok: false, url };
};

const cancelBody = async (response: Response): Promise<void> => {
    await response.body?.cancel().catch(() => undefined);
};

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_TYPE_RE = /^(?:text\/html|application\/xhtml\+xml)/iu;

/** The generic page preview: manual, re-validated redirects, capped body. */
const fetchGenericPreview = async (url: string, dependencies: LinkPreviewDependencies, startedAt: number): Promise<LinkPreview> => {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        if (dependencies.validateUrl(current) !== null) {
            return failed(url);
        }

        const remaining = LINK_PREVIEW_TIMEOUT_MS - (dependencies.now() - startedAt);

        if (remaining <= 0) {
            return failed(url);
        }

        const response = await dependencies.fetchPage(
            current,
            { headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1", "user-agent": USER_AGENT }, method: "GET" },
            remaining,
        );

        if (REDIRECT_STATUSES.has(response.status)) {
            const location = response.headers.get("location");

            await cancelBody(response);

            if (!location) {
                return failed(url);
            }

            try {
                current = new URL(location, current).href;
            } catch {
                return failed(url);
            }

            continue;
        }

        if (!response.ok || !HTML_TYPE_RE.test(response.headers.get("content-type") ?? "")) {
            await cancelBody(response);

            return failed(url);
        }

        const html = await readCappedText(response, MAX_HTML_BYTES, LINK_PREVIEW_TIMEOUT_MS - (dependencies.now() - startedAt));
        const meta = parseHtmlMeta(html, current);

        if (!meta.title && !meta.description) {
            return failed(url);
        }

        return {
            kind: "generic",
            ok: true,
            url,
            ...withoutEmpty({
                description: meta.description,
                favicon: meta.favicon,
                image: meta.image,
                siteName: meta.siteName,
                title: meta.title,
            }),
        };
    }

    return failed(url);
};

/** Drops `undefined` values, so the result only carries declared, present keys. */
const withoutEmpty = <T extends object>(value: T): Partial<T> =>
    Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;

interface GithubRepoResponse {
    description?: null | string;
    full_name?: string;
    language?: null | string;
    stargazers_count?: number;
}

interface GithubIssueResponse {
    draft?: boolean;
    merged?: boolean;
    state?: string;
    title?: string;
}

const readJson = async <T>(response: Response, startedAt: number, dependencies: LinkPreviewDependencies): Promise<T | null> => {
    const text = await readCappedText(response, MAX_HTML_BYTES, LINK_PREVIEW_TIMEOUT_MS - (dependencies.now() - startedAt));

    try {
        return JSON.parse(text) as T;
    } catch {
        return null;
    }
};

const githubState = (kind: "github-issue" | "github-pull", data: GithubIssueResponse): string | undefined => {
    if (kind === "github-pull") {
        if (data.merged) {
            return "merged";
        }

        if (data.draft && data.state === "open") {
            return "draft";
        }
    }

    return data.state === "open" || data.state === "closed" ? data.state : undefined;
};

/** A GitHub repo / issue / PR card from the REST API (unauthenticated), or `null` to fall back to the page. */
const fetchGithubPreview = async (
    url: string,
    target: Extract<UrlTarget, { kind: "github-issue" | "github-pull" | "github-repo" }>,
    dependencies: LinkPreviewDependencies,
    startedAt: number,
): Promise<LinkPreview | null> => {
    const base = `https://api.github.com/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;
    const collection = target.kind === "github-pull" ? "pulls" : "issues";
    const apiUrl = target.kind === "github-repo" ? base : `${base}/${collection}/${String(target.number)}`;
    const response = await dependencies.fetchApi(apiUrl, {
        headers: { accept: "application/vnd.github+json", "user-agent": USER_AGENT, "x-github-api-version": "2022-11-28" },
        timeoutMs: Math.max(1, LINK_PREVIEW_TIMEOUT_MS - (dependencies.now() - startedAt)),
    });

    if (!response.ok) {
        // 404 (private / missing) or 403 (unauthenticated rate limit): let the page try.
        await cancelBody(response);

        return null;
    }

    const favicon = "https://github.com/favicon.ico";

    if (target.kind === "github-repo") {
        const data = await readJson<GithubRepoResponse>(response, startedAt, dependencies);

        if (!data) {
            return null;
        }

        return {
            github: {
                owner: target.owner,
                repo: target.repo,
                ...withoutEmpty({ language: data.language ?? undefined, stars: data.stargazers_count }),
            },
            kind: "github-repo",
            ok: true,
            url,
            ...withoutEmpty({
                description: clean(data.description ?? undefined, MAX_DESCRIPTION_CHARS),
                favicon,
                siteName: "GitHub",
                title: clean(data.full_name ?? `${target.owner}/${target.repo}`, MAX_TITLE_CHARS),
            }),
        };
    }

    const data = await readJson<GithubIssueResponse>(response, startedAt, dependencies);

    if (!data) {
        return null;
    }

    return {
        github: { number: target.number, owner: target.owner, repo: target.repo, ...withoutEmpty({ state: githubState(target.kind, data) }) },
        kind: target.kind,
        ok: true,
        url,
        ...withoutEmpty({ favicon, siteName: "GitHub", title: clean(data.title, MAX_TITLE_CHARS) }),
    };
};

/**
 * The preview for one (already normalized) URL. Never throws for a remote
 * failure — a URL that cannot be previewed is `{ ok: false }`, which the caller
 * caches briefly and the client renders as nothing.
 */
export const buildLinkPreview = async (url: string, dependencies: LinkPreviewDependencies): Promise<LinkPreview> => {
    if (dependencies.validateUrl(url) !== null) {
        return failed(url);
    }

    const target = classifyUrl(url);

    if (target.kind === "linear-issue") {
        return {
            kind: "linear-issue",
            linear: { identifier: target.identifier },
            ok: true,
            siteName: "Linear",
            url,
            ...withoutEmpty({ title: target.titleFromSlug }),
        };
    }

    const startedAt = dependencies.now();

    try {
        if (target.kind !== "generic") {
            const github = await fetchGithubPreview(url, target, dependencies, startedAt);

            if (github) {
                return github;
            }
        }

        return await fetchGenericPreview(url, dependencies, startedAt);
    } catch {
        // Timeouts, refused hosts and network errors all read as "no preview".
        return failed(url, target.kind);
    }
};
