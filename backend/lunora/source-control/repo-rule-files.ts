/**
 * A repository's instruction files, read from the host with the person's own token for the rule-file import
 * (`projects/rule-file-repo.ts`): the `AGENTS.md`, `CLAUDE.md` and `GEMINI.md` at its root, and the Markdown files of
 * the first rules folder holding Markdown files. Only these paths are listed and read (`isImportablePath`), each at most
 * `REPO_RULE_FILE_MAX_BYTES` and `MAX_RULE_FILE_LENGTH` characters, all of one read together at most
 * `REPO_RULE_FILES_READ_BYTES`. Listing costs at most four requests (one more for each folder past the contents API's
 * `CONTENTS_LIST_LIMIT`), a read one per file. A symlink is listed as a file (the host does so) and read as its target.
 */
import { MAX_RULE_FILE_LENGTH, MAX_RULE_FILES_BYTES } from "../projects/rule-file-limits";
import type { HostRequest } from "./origin-fetch";
import { HostApiError } from "./origin-fetch";

/** The root files imported whole, by their standard names, in any case. */
const ROOT_FILES = new Set(["agents.md", "claude.md", "gemini.md"]);

/** The folders looked in for rule files, in order; the first holding Markdown files is listed. */
export const RULE_FOLDERS = [".rules", "rules", ".agents/rules"] as const;

const MARKDOWN_FILE = /\.(?:md|mdc|markdown)$/iu;

/** The entries the contents API lists of one folder, at most: a folder answered with this many is listed from its git tree. */
export const CONTENTS_LIST_LIMIT = 1000;

/** One file's bytes, at most: past it the file is listed but not offered. A file under it may still hold more characters than a rule file may. */
export const REPO_RULE_FILE_MAX_BYTES = 400_000;

/** The bytes one read takes, at most: what a project's rule files may hold stored. */
export const REPO_RULE_FILES_READ_BYTES = MAX_RULE_FILES_BYTES;

export interface RepoRuleFileEntry {
    path: string;
    size: number;
    tooLarge: boolean;
}

interface ContentsEntry {
    name?: unknown;
    path?: unknown;
    size?: unknown;
    type?: unknown;
}

export interface RepoAddress {
    name: string;
    owner: string;
    /** The branch to read, else the repository's default. */
    ref?: string;
}

const contentsPath = ({ name, owner }: RepoAddress, path: string): string => {
    const encoded = path
        .split("/")
        .filter(Boolean)
        .map((segment) => encodeURIComponent(segment))
        .join("/");

    return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents${encoded ? `/${encoded}` : ""}`;
};

const queryOf = (address: RepoAddress): Record<string, string> => (address.ref ? { ref: address.ref } : {});

interface TreeEntry {
    path?: unknown;
    size?: unknown;
    type?: unknown;
}

const TREE_TYPES: Record<string, string> = { blob: "file", tree: "dir" };

/**
 * A folder's entries from its git tree (one level, up to the host's 100,000), as the contents API names them: a
 * symlink is a blob there, so a file here, as in a contents listing.
 */
const listTree = async (request: HostRequest, { name, owner, ref }: RepoAddress, path: string): Promise<ContentsEntry[]> => {
    const tree = encodeURIComponent(`${ref ?? "HEAD"}:${path}`);
    const response = await request(`/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/git/trees/${tree}`);
    const body = (await response.json()) as { tree?: unknown };

    return Array.isArray(body.tree)
        ? (body.tree as TreeEntry[]).map((entry) => {
              const entryName = typeof entry.path === "string" ? entry.path : "";

              return {
                  name: entryName,
                  path: path ? `${path}/${entryName}` : entryName,
                  size: entry.size,
                  type: typeof entry.type === "string" ? TREE_TYPES[entry.type] : undefined,
              };
          })
        : [];
};

/** A folder's entries, `[]` when it is missing or is not a folder; one the contents API cuts at its limit, from its git tree. */
const listFolder = async (request: HostRequest, address: RepoAddress, path: string): Promise<ContentsEntry[]> => {
    try {
        const response = await request(contentsPath(address, path), { query: queryOf(address) });
        const body: unknown = await response.json();

        if (!Array.isArray(body)) {
            return [];
        }

        return body.length >= CONTENTS_LIST_LIMIT ? await listTree(request, address, path) : (body as ContentsEntry[]);
    } catch (error) {
        if (path !== "" && error instanceof HostApiError && error.status === 404) {
            return [];
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

/** The entries that are files a read takes (`isImportablePath`), by path. */
const filesOf = (entries: ContentsEntry[]): RepoRuleFileEntry[] =>
    entries
        .filter((entry) => entry.type === "file" && typeof entry.path === "string" && isImportablePath(entry.path))
        .map((entry) => {
            const size = typeof entry.size === "number" ? entry.size : 0;

            return { path: entry.path as string, size, tooLarge: size > REPO_RULE_FILE_MAX_BYTES };
        })
        .toSorted((left, right) => left.path.localeCompare(right.path));

const hasFolder = (entries: ContentsEntry[], name: string): boolean => entries.some((entry) => entry.type === "dir" && entry.name === name);

/** The root instruction files and the Markdown files of the first rules folder holding any (not its subfolders), by path. */
export const listRepoRuleFiles = async (request: HostRequest, address: RepoAddress): Promise<RepoRuleFileEntry[]> => {
    const root = await listFolder(request, address, "");
    const rootFiles = filesOf(root);

    for (const folder of RULE_FOLDERS) {
        const [top] = folder.split("/", 1);

        if (!hasFolder(root, top!)) {
            continue;
        }

        const files = filesOf(await listFolder(request, address, folder));

        if (files.length > 0) {
            return [...rootFiles, ...files];
        }
    }

    return rootFiles;
};

const decodeBase64 = (content: string): string => {
    const binary = atob(content.replaceAll(/\s/gu, ""));

    return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.codePointAt(0)!));
};

/** The file's text, or `undefined` when it holds more characters than a rule file may. */
const textWithinLimit = (content: string): string | undefined => {
    const text = decodeBase64(content);

    return text.length > MAX_RULE_FILE_LENGTH ? undefined : text;
};

export type RepoRuleFileRead = { path: string; status: "missing" | "too_large" } | { path: string; status: "ok"; text: string };

/**
 * The text of each of `paths` (already checked by {@link isImportablePath}), in order. One past its own limits (bytes,
 * then characters as a rule file counts them) or past what the read has left is `too_large` and spends nothing, one the
 * host no longer has `missing`; a later one may still fit.
 */
export const readRepoRuleFiles = async (request: HostRequest, address: RepoAddress, paths: ReadonlyArray<string>): Promise<RepoRuleFileRead[]> => {
    const reads: RepoRuleFileRead[] = [];
    let left = REPO_RULE_FILES_READ_BYTES;

    for (const path of paths) {
        let body: { content?: unknown; encoding?: unknown; size?: unknown; type?: unknown };

        try {
            // One at a time, so the read stops spending at its budget.
            const response = await request(contentsPath(address, path), { query: queryOf(address) });

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

        const text = textWithinLimit(body.content);

        if (text === undefined) {
            reads.push({ path, status: "too_large" });
            continue;
        }

        left -= size;
        reads.push({ path, status: "ok", text });
    }

    return reads;
};
