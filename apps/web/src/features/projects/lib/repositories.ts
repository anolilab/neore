/**
 * How the project settings and the coding-agent run picker name a project's repository (`listProjectRepos`).
 * Pinned by `repositories.test.ts`.
 */

const DOT_GIT = /\.git$/u;

/** `path` without leading or trailing slashes. */
const trimSlashes = (path: string): string => {
    let start = 0;
    let end = path.length;

    while (start < end && path[start] === "/") {
        start += 1;
    }

    while (end > start && path[end - 1] === "/") {
        end -= 1;
    }

    return path.slice(start, end);
};

/** `owner/repo` for a GitHub URL, `host/path` for any other; the URL itself when it does not parse. */
export const repoLabel = (url: string): string => {
    try {
        const parsed = new URL(url);
        const path = trimSlashes(parsed.pathname.replace(DOT_GIT, ""));

        if (!path) {
            return url;
        }

        // `host` keeps a non-default port, so two servers on one hostname stay apart.
        return parsed.host === "github.com" ? path : `${parsed.host}/${path}`;
    } catch {
        return url;
    }
};

/** Labels for a list, each `repoLabel` unless two entries share one: those show their full URL. */
export const repoLabels = (urls: ReadonlyArray<string>): string[] => {
    const labels = urls.map((url) => repoLabel(url));

    return labels.map((label, index) => (labels.indexOf(label) === labels.lastIndexOf(label) ? label : (urls[index] ?? label)));
};

const GITHUB_SHORTHAND = /^[\w.-]+\/[\w.-]+$/u;
const GITHUB_SEGMENT = /^[A-Za-z0-9][\w.-]{0,99}$/u;

/**
 * A typed repository in the form the backend stores (`parseRepoUrl(..).cloneUrl` in `coding-agents/commands.ts`), so it
 * can be matched against a project's entries while it is typed. `undefined` for anything the backend would refuse (not
 * https, credentials, a query or fragment, a GitHub path that is not owner/repo), so an invalid URL never matches.
 */
export const storedRepoUrl = (raw: string): string | undefined => {
    const input = raw.trim();
    let url: URL;

    try {
        url = new URL(GITHUB_SHORTHAND.test(input) ? `https://github.com/${input}` : input);
    } catch {
        return undefined;
    }

    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
        return undefined;
    }

    const host = url.hostname.toLowerCase();

    if (host !== "github.com" && host !== "www.github.com") {
        return url.href;
    }

    // Trailing slashes first, as the backend does: `web.git/` is `web`, never `web.git.git`.
    const segments = trimSlashes(url.pathname).replace(DOT_GIT, "").split("/").filter(Boolean);
    const [owner, repo] = segments;

    return segments.length === 2 && owner && repo && GITHUB_SEGMENT.test(owner) && GITHUB_SEGMENT.test(repo)
        ? `https://github.com/${owner}/${repo}.git`
        : undefined;
};

/**
 * How often an open settings section or run picker reads a project's repositories again: the list is not live
 * (`NEVER_LIVE`), so another member's or tab's change shows only on a read.
 */
export const REPOSITORIES_REFRESH_MS = 15_000;
