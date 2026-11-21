/**
 * A repository's instruction files, read from the host with the person's own token for the rule-file import
 * (`projects/rule-file-repo.ts`): the `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` at its root, and the Markdown files of
 * the first rules folder holding Markdown files. Only these paths are listed and read (`isImportablePath`), each at most
 * `REPO_RULE_FILE_MAX_BYTES` and `MAX_RULE_FILE_LENGTH` characters, all of one read together at most
 * `REPO_RULE_FILES_READ_BYTES`.
 *
 * A listing pins one commit (`GET /repos/{owner}/{repo}/commits?sha=<branch>&per_page=1`, the default branch when the
 * project names none), then reads only the git trees it needs, by their SHAs: the root's, and each rules folder's on
 * the way to the first holding Markdown (`.agents` before `.agents/rules`). A tree the host cuts (`truncated`) is listed
 * as far as it goes, and the listing says so. A read lists again at the commit it is given, found under this repository
 * (`/git/commits/{sha}`), and takes only the files that listing holds, by their blob SHAs: never a path the listing
 * would not offer, never a commit the host does not find under this repository (or, as the host shares objects, its
 * fork network).
 *
 * A symlink is a blob holding its target's path. It is followed only to another path of the same listing (a root
 * instruction file, or a file of the rules folder listed), inside the repository, at most `MAX_LINK_HOPS` links deep; any other is listed as `refused` and never read: the contents API
 * would follow `AGENTS.md → .env` and hand over `.env`.
 */
import { MAX_RULE_FILE_LENGTH, MAX_RULE_FILES_BYTES, RULE_FILE_FRONT_MATTER } from "../projects/rule-file-limits";
import type { HostRequest } from "./origin-fetch";
import { HostApiError } from "./origin-fetch";

/** The root files imported whole, by their standard names, in any case. */
const ROOT_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);

/** The folders looked in for rule files, in order; the first holding Markdown files is listed. */
export const RULE_FOLDERS = [".rules", "rules", ".agents/rules"] as const;

const MARKDOWN_FILE = /\.(?:md|mdc|markdown)$/iu;

/** A commit SHA as the host writes one: SHA-1, or SHA-256. */
export const COMMIT_SHA = /^(?:[\da-f]{40}|[\da-f]{64})$/u;

/** One file's bytes, at most: past it the file is listed but not offered. A file under it may still hold more characters than a rule file may. */
export const REPO_RULE_FILE_MAX_BYTES = 400_000;

/** The bytes one read takes, at most: what a project's rule files may hold stored. */
export const REPO_RULE_FILES_READ_BYTES = MAX_RULE_FILES_BYTES;

/** A git tree entry's mode for a symlink. */
const SYMLINK_MODE = "120000";

/** Links followed from one path, at most: a longer chain, or a loop, is refused. */
export const MAX_LINK_HOPS = 4;

/** Links one listing or read follows, at most, hops counted: past it a link is refused, never read unchecked. */
export const MAX_LINKS_FOLLOWED = 20;

/** A link's target path, in bytes, at most: a longer one is refused unread. */
const MAX_LINK_TARGET_BYTES = 1024;

export interface RepoRuleFileEntry {
    path: string;
    /** Set for a symlink that leads outside the rule-file paths (or nowhere): listed, never read. */
    refused?: "link";
    size: number;
    tooLarge: boolean;
}

export interface RepoRuleFileListing {
    /** The commit listed, which a read then reads at; absent for a repository with no commit yet. */
    commit?: string;
    files: RepoRuleFileEntry[];
    /** Whether a tree the listing read was cut by the host, so a file may be missing from `files`. */
    truncated: boolean;
}

export interface RepoAddress {
    name: string;
    owner: string;
    /** The branch to list, else the repository's default. */
    ref?: string;
}

interface TreeEntry {
    mode?: unknown;
    path?: unknown;
    sha?: unknown;
    size?: unknown;
    type?: unknown;
}

interface Tree {
    entries: TreeEntry[];
    truncated: boolean;
}

/** A blob of a tree: a file, or a symlink holding its target's path. */
interface Blob {
    link: boolean;
    sha: string;
    size: number;
}

/** A listed path and the blob a read takes for it (a link's final target), or none for a refused link. */
interface Found {
    blob?: Blob;
    entry: RepoRuleFileEntry;
}

const repoPath = ({ name, owner }: RepoAddress): string => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

/** A host answer meaning the commit or blob is not there: 404, 422 (not a valid object), or 409 (an emptied repository). */
const NOT_THERE = new Set([404, 409, 422]);

const isNotFound = (error: unknown): boolean => error instanceof HostApiError && NOT_THERE.has(error.status);

/** The commit the listing reads at and its root tree, or `undefined` for a repository with no commit (the host answers 409). */
const headCommit = async (request: HostRequest, address: RepoAddress): Promise<{ commit: string; tree: string } | undefined> => {
    try {
        const response = await request(`${repoPath(address)}/commits`, { query: { per_page: 1, ...(address.ref && { sha: address.ref }) } });
        const [latest] = ((await response.json()) as { commit?: { tree?: { sha?: unknown } }; sha?: unknown }[] | null) ?? [];
        const commit = latest?.sha;
        const tree = latest?.commit?.tree?.sha;

        return typeof commit === "string" && COMMIT_SHA.test(commit) && typeof tree === "string" ? { commit, tree } : undefined;
    } catch (error) {
        if (error instanceof HostApiError && error.status === 409) {
            return undefined;
        }

        throw error;
    }
};

/** The root tree of `commit`, looked up under this repository: `undefined` when the repository holds no such commit. */
const commitTree = async (request: HostRequest, address: RepoAddress, commit: string): Promise<string | undefined> => {
    try {
        const response = await request(`${repoPath(address)}/git/commits/${encodeURIComponent(commit)}`);
        const body = (await response.json()) as { tree?: { sha?: unknown } } | null;

        return typeof body?.tree?.sha === "string" ? body.tree.sha : undefined;
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }

        throw error;
    }
};

/** One level of the tree `sha`. */
const readTree = async (request: HostRequest, address: RepoAddress, sha: string): Promise<Tree> => {
    const response = await request(`${repoPath(address)}/git/trees/${encodeURIComponent(sha)}`);
    const body = (await response.json()) as { tree?: unknown; truncated?: unknown };

    return { entries: Array.isArray(body.tree) ? (body.tree as TreeEntry[]) : [], truncated: body.truncated === true };
};

/** `content`, base64, decoded as UTF-8 (a byte-order mark dropped), or `undefined` when it is not base64. */
const decodeBase64 = (content: string): string | undefined => {
    let binary: string;

    try {
        binary = atob(content.replaceAll(/\s/gu, ""));
    } catch {
        return undefined;
    }

    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.codePointAt(0)!));
};

/** The text of the blob `sha`, or `undefined` when the host sends it otherwise than as base64 (or no longer has it). */
const readBlob = async (request: HostRequest, address: RepoAddress, sha: string): Promise<string | undefined> => {
    try {
        const response = await request(`${repoPath(address)}/git/blobs/${encodeURIComponent(sha)}`);
        const body = (await response.json()) as { content?: unknown; encoding?: unknown };

        return body.encoding === "base64" && typeof body.content === "string" ? decodeBase64(body.content) : undefined;
    } catch (error) {
        if (isNotFound(error)) {
            return undefined;
        }

        throw error;
    }
};

/** Whether `path` is one {@link listRepoRuleFiles} can list: a root instruction file, or a Markdown file right in a rules folder. */
export const isImportablePath = (path: string): boolean => {
    const slash = path.lastIndexOf("/");
    const folder = path.slice(0, Math.max(0, slash));
    const name = path.slice(slash + 1);

    if (name === "" || name.startsWith(".") || path.includes("\\")) {
        return false;
    }

    return slash === -1 ? ROOT_FILES.has(name.toLowerCase()) : (RULE_FOLDERS as ReadonlyArray<string>).includes(folder) && MARKDOWN_FILE.test(name);
};

/**
 * The repository path the link at `linkPath` leads to when it holds `target`, or `undefined` for one that is absolute
 * or climbs out of the repository's root.
 */
export const resolveLinkTarget = (linkPath: string, target: string): string | undefined => {
    if (target.startsWith("/") || target.includes("\\") || target.includes("\0")) {
        return undefined;
    }

    const parts = linkPath.split("/").slice(0, -1);

    for (const segment of target.split("/")) {
        if (segment === "..") {
            if (parts.length === 0) {
                return undefined;
            }

            parts.pop();
        } else if (segment !== "" && segment !== ".") {
            parts.push(segment);
        }
    }

    return parts.length > 0 ? parts.join("/") : undefined;
};

/** A tree entry as a blob; one without a size is none: its bytes could not be checked before reading it. */
const asBlob = (entry: TreeEntry | undefined): Blob | undefined =>
    entry?.type === "blob" && typeof entry.sha === "string" && typeof entry.size === "number"
        ? { link: entry.mode === SYMLINK_MODE, sha: entry.sha, size: entry.size }
        : undefined;

/**
 * The repository at one commit, read lazily from its root tree `root`: a folder's tree once however often asked,
 * links followed within the budget of {@link MAX_LINKS_FOLLOWED}.
 */
const snapshot = (request: HostRequest, address: RepoAddress, root: Tree) => {
    const trees = new Map<string, Tree | undefined>([["", root]]);
    let { truncated } = root;
    let linksLeft = MAX_LINKS_FOLLOWED;

    const treeAt = async (path: string): Promise<Tree | undefined> => {
        if (trees.has(path)) {
            return trees.get(path);
        }

        const slash = path.lastIndexOf("/");
        const parent = await treeAt(path.slice(0, Math.max(0, slash)));
        const entry = parent?.entries.find((candidate) => candidate.type === "tree" && candidate.path === path.slice(slash + 1));
        const tree = typeof entry?.sha === "string" ? await readTree(request, address, entry.sha) : undefined;

        truncated ||= tree?.truncated === true;
        trees.set(path, tree);

        return tree;
    };

    /** The blob at `path`, if its folder's tree holds one. */
    const blobAt = async (path: string): Promise<Blob | undefined> => {
        const slash = path.lastIndexOf("/");
        const tree = await treeAt(path.slice(0, Math.max(0, slash)));

        return asBlob(tree?.entries.find((candidate) => candidate.path === path.slice(slash + 1)));
    };

    /**
     * The file `blob` at `path` leads to: itself, or a link's final target when every hop is a path `offers` accepts;
     * else `undefined`.
     */
    const follow = async (path: string, blob: Blob, offers: (target: string) => boolean): Promise<Blob | undefined> => {
        let at = path;
        let current: Blob | undefined = blob;

        for (let hop = 0; hop <= MAX_LINK_HOPS; hop += 1) {
            if (!current?.link) {
                return current;
            }

            if (hop === MAX_LINK_HOPS || linksLeft <= 0 || current.size > MAX_LINK_TARGET_BYTES) {
                return undefined;
            }

            linksLeft -= 1;
            const content = await readBlob(request, address, current.sha);
            const target = content === undefined ? undefined : resolveLinkTarget(at, content);

            if (target === undefined || !offers(target)) {
                return undefined;
            }

            at = target;
            current = await blobAt(target);
        }

        return undefined;
    };

    /** The blobs of the folder `folder` (`""` for the root) at an importable path, links not yet followed. */
    const importableIn = (folder: string, tree: Tree): { blob: Blob; path: string }[] =>
        tree.entries.flatMap((entry) => {
            const blob = asBlob(entry);

            if (!blob || typeof entry.path !== "string") {
                return [];
            }

            const path = folder ? `${folder}/${entry.path}` : entry.path;

            return isImportablePath(path) ? [{ blob, path }] : [];
        });

    /**
     * The root instruction files and the Markdown files of the first rules folder holding any (not its subfolders),
     * links followed only to a path of the same listing: a root file, or a file of that folder.
     */
    const list = async (): Promise<Found[]> => {
        let candidates = importableIn("", root);
        let chosen: string | undefined;

        for (const folder of RULE_FOLDERS) {
            const tree = await treeAt(folder);
            const files = tree ? importableIn(folder, tree) : [];

            if (files.length > 0) {
                candidates = [...candidates, ...files];
                chosen = folder;
                break;
            }
        }

        const offers = (target: string): boolean =>
            isImportablePath(target) &&
            (!target.includes("/") || (chosen !== undefined && target.startsWith(`${chosen}/`) && !target.slice(chosen.length + 1).includes("/")));
        const found: Found[] = [];

        for (const { blob, path } of candidates) {
            const file = await follow(path, blob, offers);

            found.push(
                file
                    ? { blob: file, entry: { path, size: file.size, tooLarge: file.size > REPO_RULE_FILE_MAX_BYTES } }
                    : { entry: { path, refused: "link", size: blob.size, tooLarge: false } },
            );
        }

        return found.toSorted((left, right) => left.entry.path.localeCompare(right.entry.path));
    };

    return { list, truncated: () => truncated };
};

/**
 * The root instruction files and the Markdown files of the first rules folder holding any (not its subfolders), by
 * path, at one commit; nothing for a repository with no commit.
 */
export const listRepoRuleFiles = async (request: HostRequest, address: RepoAddress): Promise<RepoRuleFileListing> => {
    const head = await headCommit(request, address);

    if (!head) {
        return { files: [], truncated: false };
    }

    const atHead = snapshot(request, address, await readTree(request, address, head.tree));
    const files = await atHead.list();

    return { commit: head.commit, files: files.map((file) => file.entry), truncated: atHead.truncated() };
};

/**
 * Whether `text` (decoded, so without a byte-order mark) can make a rule file a save takes: its length counted as the
 * import counts it, without the front matter of a folder's file (a root instruction file is taken whole). The editor
 * checks the body it made exactly; this only never refuses one it would take.
 */
const fitsRuleFile = (path: string, text: string): boolean => {
    const frontMatter = path.includes("/") ? (RULE_FILE_FRONT_MATTER.exec(text)?.[0].length ?? 0) : 0;

    return text.length - frontMatter <= MAX_RULE_FILE_LENGTH;
};

export type RepoRuleFileRead = { path: string; status: "missing" | "refused" | "too_large" } | { path: string; status: "ok"; text: string };

/**
 * The text of each of `paths` (already checked by {@link isImportablePath}) at `commit` (the listing's), in order, as
 * that commit's listing holds them: one it does not list (gone, another rules folder, or a commit this repository does
 * not hold) is `missing`, a refused link `refused`. One past its own limits (bytes, then characters as the import counts
 * them, {@link fitsRuleFile}) or past what the read has left is `too_large` and spends nothing; a later one may still fit.
 */
export const readRepoRuleFiles = async (
    request: HostRequest,
    address: RepoAddress,
    commit: string,
    paths: ReadonlyArray<string>,
): Promise<RepoRuleFileRead[]> => {
    const rootSha = await commitTree(request, address, commit);

    if (rootSha === undefined) {
        return paths.map((path) => {
            return { path, status: "missing" };
        });
    }

    const atCommit = snapshot(request, address, await readTree(request, address, rootSha));
    const offered = await atCommit.list();
    const listed = new Map(offered.map((file) => [file.entry.path, file]));
    const reads: RepoRuleFileRead[] = [];
    let left = REPO_RULE_FILES_READ_BYTES;

    for (const path of paths) {
        const found = listed.get(path);

        if (!found) {
            reads.push({ path, status: "missing" });
            continue;
        }

        if (!found.blob) {
            reads.push({ path, status: "refused" });
            continue;
        }

        const { size } = found.blob;

        if (size > REPO_RULE_FILE_MAX_BYTES || size > left) {
            reads.push({ path, status: "too_large" });
            continue;
        }

        // One at a time, so the read stops spending at its budget.
        const text = await readBlob(request, address, found.blob.sha);

        if (text === undefined) {
            reads.push({ path, status: "missing" });
            continue;
        }

        if (!fitsRuleFile(path, text)) {
            reads.push({ path, status: "too_large" });
            continue;
        }

        left -= size;
        reads.push({ path, status: "ok", text });
    }

    return reads;
};
