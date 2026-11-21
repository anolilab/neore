/**
 * A repository's instruction files, read from the host with the person's own token for the rule-file import
 * (`projects/rule-file-repo.ts`): the `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` at its root, and the Markdown files of
 * the first rules folder holding Markdown files. Only these paths are listed and read (`isImportablePath`), each at most
 * `REPO_RULE_FILE_MAX_BYTES` and `MAX_RULE_FILE_LENGTH` characters, all of one read together at most
 * `REPO_RULE_FILES_READ_BYTES`.
 *
 * A listing pins one commit (`GET /repos/{owner}/{repo}/commits?sha=<branch>&per_page=1`, the default branch when the
 * project names none), then reads only the git trees it needs, by their SHAs: the root's, and each rules folder's on
 * the way to the first holding Markdown (`.agents` before `.agents/rules`), six requests at most. A tree the host cuts
 * (`truncated`) is listed as far as it goes, and the listing says so. A read takes each file from the contents API at
 * that commit, so it reads what was listed even when the branch has moved since. A symlink is listed as a file (a blob
 * in its tree) and read as its target.
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

export interface RepoRuleFileEntry {
    path: string;
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
    path?: unknown;
    sha?: unknown;
    size?: unknown;
    type?: unknown;
}

interface Tree {
    entries: TreeEntry[];
    truncated: boolean;
}

const repoPath = ({ name, owner }: RepoAddress): string => `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;

const contentsPath = (address: RepoAddress, path: string): string => {
    const encoded = path
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");

    return `${repoPath(address)}/contents${encoded ? `/${encoded}` : ""}`;
};

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

/** One level of the tree `sha`. */
const readTree = async (request: HostRequest, address: RepoAddress, sha: string): Promise<Tree> => {
    const response = await request(`${repoPath(address)}/git/trees/${encodeURIComponent(sha)}`);
    const body = (await response.json()) as { tree?: unknown; truncated?: unknown };

    return { entries: Array.isArray(body.tree) ? (body.tree as TreeEntry[]) : [], truncated: body.truncated === true };
};

/** The SHA of the folder `name` right in `tree`, if it holds one. */
const folderSha = (tree: Tree, name: string): string | undefined => {
    const entry = tree.entries.find((candidate) => candidate.type === "tree" && candidate.path === name);

    return typeof entry?.sha === "string" ? entry.sha : undefined;
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

/** The files of `tree` (the folder at `folder`, `""` for the root) a read takes (`isImportablePath`), by path. */
const filesOf = (tree: Tree, folder: string): RepoRuleFileEntry[] =>
    tree.entries
        .flatMap((entry) => {
            // A symlink is a blob too: listed as a file, read as its target.
            if (entry.type !== "blob" || typeof entry.path !== "string") {
                return [];
            }

            const path = folder ? `${folder}/${entry.path}` : entry.path;
            const size = typeof entry.size === "number" ? entry.size : 0;

            return isImportablePath(path) ? [{ path, size, tooLarge: size > REPO_RULE_FILE_MAX_BYTES }] : [];
        })
        .toSorted((left, right) => left.path.localeCompare(right.path));

/**
 * The root instruction files and the Markdown files of the first rules folder holding any (not its subfolders), by
 * path, at one commit; nothing for a repository with no commit.
 */
export const listRepoRuleFiles = async (request: HostRequest, address: RepoAddress): Promise<RepoRuleFileListing> => {
    const head = await headCommit(request, address);

    if (!head) {
        return { files: [], truncated: false };
    }

    const root = await readTree(request, address, head.tree);
    let { truncated } = root;
    // The folders read so far, by path: `.agents` once, however many rules folders sit in it.
    const trees = new Map<string, Tree | undefined>([["", root]]);

    const treeAt = async (path: string): Promise<Tree | undefined> => {
        if (trees.has(path)) {
            return trees.get(path);
        }

        const slash = path.lastIndexOf("/");
        const parent = await treeAt(path.slice(0, Math.max(0, slash)));
        const sha = parent && folderSha(parent, path.slice(slash + 1));
        const tree = sha ? await readTree(request, address, sha) : undefined;

        truncated ||= tree?.truncated === true;
        trees.set(path, tree);

        return tree;
    };

    const rootFiles = filesOf(root, "");

    for (const folder of RULE_FOLDERS) {
        const tree = await treeAt(folder);
        const files = tree ? filesOf(tree, folder) : [];

        if (files.length > 0) {
            return { commit: head.commit, files: [...rootFiles, ...files], truncated };
        }
    }

    return { commit: head.commit, files: rootFiles, truncated };
};

const decodeBase64 = (content: string): string => {
    const binary = atob(content.replaceAll(/\s/gu, ""));

    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.codePointAt(0)!));
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

export type RepoRuleFileRead = { path: string; status: "missing" | "too_large" } | { path: string; status: "ok"; text: string };

/**
 * The text of each of `paths` (already checked by {@link isImportablePath}) at `commit` (the listing's), in order. One
 * past its own limits (bytes, then characters as the import counts them, {@link fitsRuleFile}) or past what the read has left is `too_large` and spends nothing, one the
 * host no longer has `missing`; a later one may still fit.
 */
export const readRepoRuleFiles = async (
    request: HostRequest,
    address: RepoAddress,
    commit: string,
    paths: ReadonlyArray<string>,
): Promise<RepoRuleFileRead[]> => {
    const reads: RepoRuleFileRead[] = [];
    let left = REPO_RULE_FILES_READ_BYTES;

    for (const path of paths) {
        let body: { content?: unknown; encoding?: unknown; size?: unknown; type?: unknown };

        try {
            // One at a time, so the read stops spending at its budget.
            const response = await request(contentsPath(address, path), { query: { ref: commit } });

            body = (await response.json()) as typeof body;
        } catch (error) {
            if (error instanceof HostApiError && error.status === 404) {
                reads.push({ path, status: "missing" });
                continue;
            }

            throw error;
        }

        const size = typeof body.size === "number" ? body.size : Infinity;

        if (body.type !== "file" || body.encoding !== "base64" || typeof body.content !== "string") {
            reads.push({ path, status: size > REPO_RULE_FILE_MAX_BYTES ? "too_large" : "missing" });
            continue;
        }

        if (size > REPO_RULE_FILE_MAX_BYTES || size > left) {
            reads.push({ path, status: "too_large" });
            continue;
        }

        const text = decodeBase64(body.content);

        if (!fitsRuleFile(path, text)) {
            reads.push({ path, status: "too_large" });
            continue;
        }

        left -= size;
        reads.push({ path, status: "ok", text });
    }

    return reads;
};
