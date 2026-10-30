/**
 * Repository identity: a git remote, or a pasted web address of a repository,
 * parsed into `{ hostKind, origin, path }`. Pure.
 *
 * The host KIND of a custom domain is never guessed from its name. The user
 * declares it when they connect the domain (`DeclaredHost`), and an undeclared
 * domain parses as `"unknown"`. Only the vendors' own hosted domains are known.
 *
 * `origin` is the WEB origin a token is bound to. An SSH remote carries no web
 * origin, so it resolves to `https://<host>` (or the declared origin), never to
 * the SSH port. `path` is what the host's API addresses: `owner/repo`,
 * `group/sub/repo`, or Azure's `organization/project/repo`.
 */

export const HOST_KINDS = ["azure", "bitbucket", "forgejo", "github", "gitlab"] as const;

export type HostKind = (typeof HOST_KINDS)[number];

export interface DeclaredHost {
    /** A subpath the server is mounted under, `git` for `https://example.com/git/owner/repo`. */
    basePath?: string;
    hostKind: HostKind;
    /** `https://git.example.com` or `https://git.example.com:8443`. */
    origin: string;
}

export interface RepoIdentity {
    hostKind: HostKind | "unknown";
    origin: string;
    path: string;
}

const MAX_REMOTE_LENGTH = 2048;
const URL_SCHEMES = new Set(["git+ssh:", "git:", "http:", "https:", "ssh+git:", "ssh:"]);
const SSH_SCHEMES = new Set(["git+ssh:", "ssh+git:", "ssh:"]);
const SCP_FORM = /^(?:[^\s/:@]+@)?([^\s/:@]+):(?!\/\/)(.+)$/u;
const URL_PATH = /^[^/]*\/\/[^/]*(\/.*)?$/u;
const LEADING_SLASH = /^\//u;
const TRAILING_SLASH = /\/$/u;
const WHITESPACE = /\s/u;
const AZURE_LEGACY_HOST = /^(?!vs-ssh\.)([a-z0-9-]+)\.visualstudio\.com$/u;
const AZURE_LEGACY_SSH_HOST = /^vs-ssh\.visualstudio\.com$/u;

/** Hosted services identified by their own domain, as opposed to a domain somebody pointed at a server. */
const PUBLIC_HOSTS: Record<string, HostKind> = {
    "bitbucket.org": "bitbucket",
    "codeberg.org": "forgejo",
    "dev.azure.com": "azure",
    "github.com": "github",
    "gitlab.com": "gitlab",
};

/** SSH-only host names of those services, mapped to the web host. */
const SSH_ALIASES: Record<string, string> = {
    "ssh.dev.azure.com": "dev.azure.com",
    "ssh.github.com": "github.com",
};

const normaliseBasePath = (basePath: string | undefined): string => (basePath ?? "").split("/").filter(Boolean).join("/");

const hasControlCharacter = (text: string): boolean =>
    [...text].some((character) => {
        const code = character.codePointAt(0) ?? 0;

        return code < 0x20 || code === 0x7f;
    });

const hasControlOrSpace = (text: string): boolean => WHITESPACE.test(text) || hasControlCharacter(text);

/** Decoded segments of a path as written; `undefined` for an empty, `.`, `..` or otherwise unsafe one. One leading and one trailing slash are allowed. */
const readSegments = (rawPath: string): string[] | undefined => {
    const segments: string[] = [];
    const trimmed = rawPath.replace(LEADING_SLASH, "").replace(TRAILING_SLASH, "");
    const raws = trimmed === "" ? [] : trimmed.split("/");

    for (const raw of raws) {
        if (raw === "") {
            return undefined;
        }

        let decoded: string;

        try {
            decoded = decodeURIComponent(raw);
        } catch {
            return undefined;
        }

        if (decoded === "." || decoded === ".." || decoded.includes("/") || decoded.includes("\\") || hasControlOrSpace(decoded.replaceAll(" ", ""))) {
            return undefined;
        }

        segments.push(decoded);
    }

    return segments;
};

const stripGitSuffix = (segments: string[]): string[] => {
    const last = segments.at(-1);

    return last !== undefined && last.length > 4 && last.endsWith(".git") ? [...segments.slice(0, -1), last.slice(0, -4)] : segments;
};

interface Located {
    basePath: string;
    hostKind: HostKind | "unknown";
    origin: string;
}

const known = (host: string): HostKind | undefined => {
    if (Object.hasOwn(PUBLIC_HOSTS, host)) {
        return PUBLIC_HOSTS[host];
    }

    return AZURE_LEGACY_HOST.test(host) ? "azure" : undefined;
};

/**
 * Which host a remote points at. `webOrigin` is the origin for an http(s) form,
 * and `undefined` for an SSH form, which can match a declared host by name only.
 */
/** Whether a host from an SCP-style remote parses as a URL authority, so the origin built from it is valid. */
const isPlainHost = (host: string): boolean => {
    try {
        return new URL(`https://${host}`).hostname !== "";
    } catch {
        return false;
    }
};

const locate = (host: string, webOrigin: string | undefined, segments: string[], declared: DeclaredHost[]): Located => {
    let best: (DeclaredHost & { base: string }) | undefined;
    // An SSH path never carries the web mount prefix: a declaration for the host still names its kind.
    let sshFallback: (DeclaredHost & { origin: string }) | undefined;

    for (const candidate of declared) {
        let candidateUrl: URL;

        try {
            candidateUrl = new URL(candidate.origin);
        } catch {
            continue;
        }

        const matches = webOrigin === undefined ? candidateUrl.hostname === host : candidateUrl.origin === webOrigin;
        const base = normaliseBasePath(candidate.basePath);
        const underBase = base === "" || segments.join("/").startsWith(`${base}/`);

        if (matches && underBase && (best === undefined || base.length > best.base.length)) {
            best = { ...candidate, base, origin: candidateUrl.origin };
        }

        if (matches && webOrigin === undefined && sshFallback === undefined) {
            sshFallback = { ...candidate, origin: candidateUrl.origin };
        }
    }

    if (best) {
        return { basePath: best.base, hostKind: best.hostKind, origin: best.origin };
    }

    if (sshFallback) {
        return { basePath: "", hostKind: sshFallback.hostKind, origin: sshFallback.origin };
    }

    const webHost = SSH_ALIASES[host] ?? (AZURE_LEGACY_SSH_HOST.test(host) ? "dev.azure.com" : host);
    const hostKind = known(webHost);
    // A known service's origin has no custom port: a port on the web form means a different server.
    const portless = webOrigin === undefined || webOrigin === `https://${host}`;
    const origin = webOrigin ?? `https://${webHost}`;

    return { basePath: "", hostKind: hostKind !== undefined && portless ? hostKind : "unknown", origin };
};

const twoSegments = (segments: string[]): string | undefined => (segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined);

const azurePath = (segments: string[], host: string, viaSsh: boolean): string | undefined => {
    if (viaSsh) {
        // v3/<organization>/<project>/<repo>
        return segments[0] === "v3" && segments.length >= 4 ? segments.slice(1, 4).join("/") : undefined;
    }

    const gitIndex = segments.indexOf("_git");
    const repo = gitIndex === -1 ? undefined : segments[gitIndex + 1];

    if (repo === undefined) {
        return undefined;
    }

    const legacyOrg = AZURE_LEGACY_HOST.exec(host)?.[1];
    // dev.azure.com/<org>/<project>/_git/<repo>; the legacy host carries the organization in its name, and may add `DefaultCollection`.
    const leading = segments
        .slice(0, gitIndex)
        .filter((segment, index) => !(legacyOrg !== undefined && index === 0 && segment.toLowerCase() === "defaultcollection"));
    const [organization, project] = legacyOrg === undefined ? [leading[0], leading[1] ?? repo] : [legacyOrg, leading[0] ?? repo];

    return organization === undefined || project === undefined ? undefined : `${organization}/${project}/${repo}`;
};

const pathFor = (located: Located, segments: string[], host: string, viaSsh: boolean): string | undefined => {
    const base = located.basePath === "" ? [] : located.basePath.split("/");
    const rest = segments.slice(base.length);

    switch (located.hostKind) {
        case "azure": {
            return azurePath(rest, host, viaSsh);
        }
        case "bitbucket":
        case "forgejo":
        case "github": {
            return twoSegments(rest);
        }
        case "gitlab": {
            const dash = rest.indexOf("-");
            const projectSegments = dash === -1 ? rest : rest.slice(0, dash);

            return projectSegments.length >= 2 ? projectSegments.join("/") : undefined;
        }
        default: {
            return rest.length >= 2 ? rest.join("/") : undefined;
        }
    }
};

/**
 * Parses `remote`, or returns `null` when it is not a repository address:
 * a shape this does not read, a query or fragment, or a path with an empty,
 * `.` or `..` segment. Credentials in the address are dropped, never returned.
 */
export const parseRepoRemote = (remote: string, declared: DeclaredHost[] = []): RepoIdentity | null => {
    const input = remote.trim();

    if (input === "" || input.length > MAX_REMOTE_LENGTH || hasControlOrSpace(input) || input.includes("\\")) {
        return null;
    }

    let host: string;
    let webOrigin: string | undefined;
    let rawPath: string;
    let viaSsh: boolean;

    if (input.includes("://")) {
        let url: URL;

        try {
            url = new URL(input);
        } catch {
            return null;
        }

        if (!URL_SCHEMES.has(url.protocol) || url.hostname === "" || input.includes("?") || input.includes("#")) {
            return null;
        }

        viaSsh = SSH_SCHEMES.has(url.protocol) || url.protocol === "git:";
        host = url.hostname.toLowerCase();
        webOrigin = viaSsh ? undefined : url.origin;
        // As written: `url.pathname` has already folded `//` and `..` away.
        rawPath = URL_PATH.exec(input)?.[1] ?? "";
    } else {
        const scp = SCP_FORM.exec(input);

        // A host with no dot is a URL scheme (`javascript:`), not a server.
        if (!scp || !(scp[1] as string).includes(".") || input.includes("?") || input.includes("#")) {
            return null;
        }

        host = (scp[1] as string).toLowerCase();

        // The host becomes the origin of every request, so it must parse as a URL authority.
        if (!isPlainHost(host)) {
            return null;
        }

        viaSsh = true;
        rawPath = scp[2] as string;
    }

    const segments = readSegments(rawPath);

    if (segments === undefined) {
        return null;
    }

    const located = locate(host, webOrigin, stripGitSuffix(segments), declared);
    const path = pathFor(located, stripGitSuffix(segments), host, viaSsh);

    return path === undefined ? null : { hostKind: located.hostKind, origin: located.origin, path };
};
