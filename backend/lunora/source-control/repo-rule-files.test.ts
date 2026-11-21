import { describe, expect, it } from "vitest";

import { HostApiError } from "./origin-fetch";
import type { HostRequest } from "./origin-fetch";
import { MAX_RULE_FILE_LENGTH } from "../projects/rule-file-limits";
import {
    fetchBudget,
    HOST_FETCHES_PER_IMPORT,
    isImportablePath,
    listRepoRuleFiles,
    MAX_LISTED_FOLDER_FILES,
    MAX_LINKS_FOLLOWED,
    readRepoRuleFiles,
    REPO_RULE_FILE_MAX_BYTES,
    REPO_RULE_FILES_READ_BYTES,
    resolveLinkTarget,
} from "./repo-rule-files";
import type { RepoRuleFileListing, RepoRuleFilePick } from "./repo-rule-files";

const ADDRESS = { name: "hello", owner: "octo", ref: "main" };
const REPO = "/repos/octo/hello";
const COMMIT = "c".repeat(40);

/** A host answering each path from `routes`, recording the paths and queries asked. */
const fakeHost = (routes: Record<string, unknown>): { calls: { path: string; query: unknown }[]; request: HostRequest } => {
    const calls: { path: string; query: unknown }[] = [];
    const request: HostRequest = async (path, options) => {
        calls.push({ path, query: options?.query });

        if (!(path in routes)) {
            throw new HostApiError("missing", 404);
        }

        const answer = routes[path];

        if (answer instanceof HostApiError) {
            throw answer;
        }

        return Response.json(answer);
    };

    return { calls, request };
};

const blob = (path: string, size = 10) => {
    return { mode: "100644", path, sha: `blob-${path}`, size, type: "blob" };
};

const folder = (path: string) => {
    return { mode: "040000", path, sha: `tree-${path}`, type: "tree" };
};

/** The commit list answering the listing's first request: one commit, its root tree `tree-root`. */
const commits = [{ commit: { tree: { sha: "tree-root" } }, sha: COMMIT }];

const tree = (sha: string) => `${REPO}/git/trees/${sha}`;

const base64 = (bytes: Uint8Array): string => {
    let binary = "";

    for (const byte of bytes) {
        binary += String.fromCodePoint(byte);
    }

    return btoa(binary);
};

/** A file of {@link repoAt}: its text, a symlink to `link`, or only a size (a blob the host would not send). */
type FakeFile = string | { link: string } | { size: number };

/**
 * The host routes of a repository at {@link COMMIT} holding `files` by path: its commit, the trees of the root and
 * each folder (`tree-<folder>`), and each blob (`blob-<path>`, slashes as `_`), a link's holding its target's path.
 */
const repoAt = (files: Record<string, FakeFile>): Record<string, unknown> => {
    const routes: Record<string, unknown> = { [`${REPO}/git/commits/${COMMIT}`]: { sha: COMMIT, tree: { sha: "tree-root" } } };
    const trees = new Map<string, unknown[]>([["root", []]]);

    for (const [path, file] of Object.entries(files)) {
        const slash = path.lastIndexOf("/");
        const folderPath = slash === -1 ? "root" : path.slice(0, slash);
        const name = path.slice(slash + 1);

        if (folderPath !== "root" && !trees.has(folderPath)) {
            trees.set(folderPath, []);
            trees.get("root")!.push(folder(folderPath));
        }

        const sha = `blob-${path.replaceAll("/", "_")}`;

        if (typeof file === "object" && "size" in file) {
            trees.get(folderPath)!.push({ mode: "100644", path: name, sha, size: file.size, type: "blob" });
            routes[`${REPO}/git/blobs/${sha}`] = { content: "", encoding: "base64", size: file.size };
            continue;
        }

        const bytes = new TextEncoder().encode(typeof file === "string" ? file : file.link);

        trees.get(folderPath)!.push({ mode: typeof file === "string" ? "100644" : "120000", path: name, sha, size: bytes.byteLength, type: "blob" });
        routes[`${REPO}/git/blobs/${sha}`] = { content: base64(bytes), encoding: "base64", size: bytes.byteLength };
    }

    for (const [folderPath, entries] of trees) {
        routes[tree(`tree-${folderPath}`)] = { tree: entries, truncated: false };
    }

    return routes;
};

/** The blob SHA {@link repoAt} gives the file at `path`. */
const sha = (path: string): string => `blob-${path.replaceAll("/", "_")}`;

/** Files of {@link repoAt} picked by path, each with its own blob's SHA, as a listing gives a file that is no link. */
const picks = (...paths: string[]): RepoRuleFilePick[] =>
    paths.map((path) => {
        return { path, sha: sha(path) };
    });

/** `paths` picked with the SHA `listing` gave each (none for a refused link). */
const picksOf = (listing: RepoRuleFileListing, paths: string[]): RepoRuleFilePick[] =>
    paths.map((path) => {
        return { path, sha: listing.files.find((file) => file.path === path)?.sha };
    });

describe(listRepoRuleFiles, () => {
    it("pins the branch's commit and lists the root instruction files in any case and the first rules folder's Markdown files", async () => {
        const { calls, request } = fakeHost({
            [`${REPO}/commits`]: commits,
            [tree("tree-root")]: { tree: [blob("AGENTS.md"), blob("claude.md"), blob("README.md"), folder("rules")], truncated: false },
            [tree("tree-rules")]: { tree: [blob("sql.md"), blob("notes.txt"), folder("nested")], truncated: false },
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toStrictEqual({
            commit: COMMIT,
            files: [
                { path: "AGENTS.md", sha: "blob-AGENTS.md", size: 10, tooLarge: false },
                { path: "claude.md", sha: "blob-claude.md", size: 10, tooLarge: false },
                { path: "rules/sql.md", sha: "blob-sql.md", size: 10, tooLarge: false },
            ],
            truncated: false,
        });
        expect(calls).toStrictEqual([
            { path: `${REPO}/commits`, query: { per_page: 1, sha: "main" } },
            { path: tree("tree-root"), query: undefined },
            { path: tree("tree-rules"), query: undefined },
        ]);
    });

    it("passes over a rules folder without Markdown to the next, reaching a nested one through its parent's tree, and lists no hidden file", async () => {
        const { calls, request } = fakeHost({
            [`${REPO}/commits`]: commits,
            [tree("tree-.agents")]: { tree: [folder("rules")] },
            [tree("tree-.rules")]: { tree: [blob("notes.txt")] },
            [tree("tree-root")]: { tree: [folder(".rules"), folder(".agents")] },
            [tree("tree-rules")]: { tree: [blob(".draft.md"), blob("style.md")] },
        });

        await expect(listRepoRuleFiles(request, { name: "hello", owner: "octo" })).resolves.toStrictEqual({
            commit: COMMIT,
            files: [{ path: ".agents/rules/style.md", sha: "blob-style.md", size: 10, tooLarge: false }],
            truncated: false,
        });
        // The default branch: no `sha` asked for. Tree ids are SHAs, never `ref:path`.
        expect(calls).toStrictEqual([
            { path: `${REPO}/commits`, query: { per_page: 1 } },
            { path: tree("tree-root"), query: undefined },
            { path: tree("tree-.rules"), query: undefined },
            { path: tree("tree-.agents"), query: undefined },
            { path: tree("tree-rules"), query: undefined },
        ]);
    });

    it("asks for no folder the root does not hold, and marks a file past the limit", async () => {
        const { calls, request } = fakeHost({
            [`${REPO}/commits`]: commits,
            [tree("tree-root")]: { tree: [blob("GEMINI.md", REPO_RULE_FILE_MAX_BYTES + 1)] },
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toStrictEqual({
            commit: COMMIT,
            files: [{ path: "GEMINI.md", sha: "blob-GEMINI.md", size: REPO_RULE_FILE_MAX_BYTES + 1, tooLarge: true }],
            truncated: false,
        });
        expect(calls).toHaveLength(2);
    });

    it("follows a symlink only to another instruction file, listing the rest as refused without reading their target", async () => {
        const { calls, request } = fakeHost({
            ...repoAt({
                "AGENTS.md": "# Rules",
                "CLAUDE.md": { link: "AGENTS.md" },
                "GEMINI.md": { link: ".env" },
                "rules/escape.md": { link: "../../outside.md" },
                "rules/loop.md": { link: "loop.md" },
                "rules/style.md": { link: "../CLAUDE.md" },
            }),
            [`${REPO}/commits`]: commits,
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toStrictEqual({
            commit: COMMIT,
            files: [
                { path: "AGENTS.md", sha: "blob-AGENTS.md", size: 7, tooLarge: false },
                // Listed with its target's size and blob: the read takes the target's.
                { path: "CLAUDE.md", sha: "blob-AGENTS.md", size: 7, tooLarge: false },
                { path: "GEMINI.md", refused: "outside", size: 4, tooLarge: false },
                { path: "rules/escape.md", refused: "outside", size: 16, tooLarge: false },
                // A loop is a chain past the depth.
                { path: "rules/loop.md", refused: "too_deep", size: 7, tooLarge: false },
                { path: "rules/style.md", sha: "blob-AGENTS.md", size: 7, tooLarge: false },
            ],
            truncated: false,
        });
        // Only links' own blobs are read while listing, never a file's.
        expect(calls.filter((call) => call.path.includes("/git/blobs/")).map((call) => call.path.split("/").at(-1))).not.toContain("blob-AGENTS.md");
    });

    it("follows a link only into the listing: never to a rules folder it passed over, never past a chain's depth, never a long target", async () => {
        const { calls, request } = fakeHost({
            ...repoAt({
                ".rules/a.md": { link: "../rules/skipped.md" },
                ".rules/b.md": "listed",
                ".rules/deep0.md": { link: "deep1.md" },
                ".rules/deep1.md": { link: "deep2.md" },
                ".rules/deep2.md": { link: "deep3.md" },
                ".rules/deep3.md": { link: "deep4.md" },
                ".rules/deep4.md": { link: "b.md" },
                ".rules/long.md": { link: `${"x/".repeat(600)}b.md` },
                "rules/skipped.md": "passed over",
            }),
            [`${REPO}/commits`]: commits,
        });
        const { files } = await listRepoRuleFiles(request, ADDRESS);

        expect(files.map((file) => [file.path, file.refused ?? "ok"])).toStrictEqual([
            [".rules/a.md", "outside"],
            [".rules/b.md", "ok"],
            // Five links from deep0 to the file, one past the limit; four from deep1.
            [".rules/deep0.md", "too_deep"],
            [".rules/deep1.md", "ok"],
            [".rules/deep2.md", "ok"],
            [".rules/deep3.md", "ok"],
            [".rules/deep4.md", "ok"],
            [".rules/long.md", "too_long"],
        ]);
        expect(calls.map((call) => call.path)).not.toContain(`${REPO}/git/blobs/blob-.rules_long.md`);
        expect(calls.map((call) => call.path)).not.toContain(`${REPO}/git/blobs/blob-rules_skipped.md`);
    });

    it("lists a link to a listed path that is not there, or whose own blob the host does not send, as broken", async () => {
        const routes = repoAt({ "CLAUDE.md": { link: "AGENTS.md" }, "GEMINI.md": { link: "CLAUDE.md" }, "rules/a.md": { link: "gone.md" } });

        routes[`${REPO}/git/blobs/blob-GEMINI.md`] = { content: "", encoding: "none" };

        const { files } = await listRepoRuleFiles(fakeHost({ ...routes, [`${REPO}/commits`]: commits }).request, ADDRESS);

        expect(files.map((file) => [file.path, file.refused])).toStrictEqual([
            ["CLAUDE.md", "broken"],
            ["GEMINI.md", "broken"],
            ["rules/a.md", "broken"],
        ]);
    });

    it("lists the links past what one listing follows as such, in path order, the same at the read", async () => {
        const files: Record<string, FakeFile> = { "AGENTS.md": "# Rules", "rules/target.md": "# Rules" };
        const links = Array.from({ length: MAX_LINKS_FOLLOWED + 2 }, (_, index) => `rules/l${String(index).padStart(2, "0")}.md`);

        // The tree out of path order, so only the listing's own order decides which links it follows.
        for (const path of links.toReversed()) {
            files[path] = { link: "target.md" };
        }

        // A root link is followed before the folder's, whose links would use the budget up first.
        files["CLAUDE.md"] = { link: "AGENTS.md" };

        const host = fakeHost({ ...repoAt(files), [`${REPO}/commits`]: commits });
        const listing = await listRepoRuleFiles(host.request, ADDRESS);

        expect(listing.files.filter((file) => file.refused === "budget").map((file) => file.path)).toStrictEqual(links.slice(MAX_LINKS_FOLLOWED - 1));
        expect(listing.files.find((file) => file.path === "CLAUDE.md")).toStrictEqual({ path: "CLAUDE.md", sha: "blob-AGENTS.md", size: 7, tooLarge: false });
        expect(listing.files.filter((file) => file.refused === undefined)).toHaveLength(MAX_LINKS_FOLLOWED + 2);
        await expect(readRepoRuleFiles(host.request, ADDRESS, COMMIT, picksOf(listing, [links[0]!, links.at(-1)!]))).resolves.toStrictEqual([
            { path: links[0], status: "ok", text: "# Rules" },
            { path: links.at(-1), status: "refused" },
        ]);
    });

    it("lists every root file and the rules folder's first files by path up to the cap, counting the rest, and reads only those listed", async () => {
        const files: Record<string, FakeFile> = { "AGENTS.md": "# Rules" };
        const folderFiles = Array.from({ length: MAX_LISTED_FOLDER_FILES + 3 }, (_, index) => `.rules/f${String(index).padStart(3, "0")}.md`);

        for (const path of folderFiles.toReversed()) {
            files[path] = "rule";
        }

        const host = fakeHost({ ...repoAt(files), [`${REPO}/commits`]: commits });
        const listing = await listRepoRuleFiles(host.request, ADDRESS);

        expect(listing.omitted).toBe(3);
        expect(listing.files.map((file) => file.path)).toStrictEqual([...folderFiles.slice(0, MAX_LISTED_FOLDER_FILES), "AGENTS.md"]);
        await expect(readRepoRuleFiles(host.request, ADDRESS, COMMIT, picks(folderFiles[0]!, folderFiles.at(-1)!))).resolves.toStrictEqual([
            { path: folderFiles[0], status: "ok", text: "rule" },
            { path: folderFiles.at(-1), status: "missing" },
        ]);
    });

    it("lists no entry without a size, whose bytes could not be checked before reading it", async () => {
        const { request } = fakeHost({
            [`${REPO}/commits`]: commits,
            [tree("tree-root")]: { tree: [{ mode: "100644", path: "AGENTS.md", sha: "s", type: "blob" }] },
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toMatchObject({ files: [] });
    });

    it("says when a tree the host cut may hide files, listing what it holds", async () => {
        const { request } = fakeHost({
            [`${REPO}/commits`]: commits,
            [tree("tree-root")]: { tree: [blob("AGENTS.md"), folder("rules")], truncated: false },
            [tree("tree-rules")]: { tree: [blob("a.md")], truncated: true },
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toMatchObject({
            files: [{ path: "AGENTS.md" }, { path: "rules/a.md" }],
            truncated: true,
        });
    });

    it("lists nothing in a repository with no commit, and passes on any other host failure", async () => {
        await expect(listRepoRuleFiles(fakeHost({ [`${REPO}/commits`]: new HostApiError("empty", 409) }).request, ADDRESS)).resolves.toStrictEqual({
            files: [],
            truncated: false,
        });
        await expect(listRepoRuleFiles(fakeHost({}).request, ADDRESS)).rejects.toBeInstanceOf(HostApiError);
    });
});

describe(isImportablePath, () => {
    it.each([
        ["AGENTS.md", true],
        ["Claude.md", true],
        [".rules/style.md", true],
        [".agents/rules/sql.mdc", true],
        ["README.md", false],
        ["src/AGENTS.md", false],
        ["rules/nested/a.md", false],
        ["rules/.hidden.md", false],
        ["rules/../secrets.md", false],
        ["rules/a.txt", false],
    ])("%s → %s", (path, expected) => {
        expect(isImportablePath(path)).toBe(expected);
    });
});

describe(resolveLinkTarget, () => {
    it.each([
        ["CLAUDE.md", "AGENTS.md", "AGENTS.md"],
        ["CLAUDE.md", "./rules/a.md", "rules/a.md"],
        ["rules/a.md", "../AGENTS.md", "AGENTS.md"],
        ["rules/a.md", "../../outside.md", undefined],
        ["AGENTS.md", "../AGENTS.md", undefined],
        ["AGENTS.md", "/etc/passwd", undefined],
        ["AGENTS.md", ".", undefined],
    ])("%s → %s is %s", (link, target, expected) => {
        expect(resolveLinkTarget(link, target)).toBe(expected);
    });
});

describe(readRepoRuleFiles, () => {
    it("decodes each file as UTF-8 at the listing's commit, found under this repository, and says which are gone", async () => {
        const host = fakeHost(repoAt({ "AGENTS.md": "# Règles\nUse pnpm." }));

        await expect(readRepoRuleFiles(host.request, ADDRESS, COMMIT, picks("AGENTS.md", "CLAUDE.md"))).resolves.toStrictEqual([
            { path: "AGENTS.md", status: "ok", text: "# Règles\nUse pnpm." },
            { path: "CLAUDE.md", status: "missing" },
        ]);
        // The commit is looked up under this repository, and the files by their blobs: never a branch, never a path the host resolves.
        expect(host.calls.map((call) => call.path)).toStrictEqual([`${REPO}/git/commits/${COMMIT}`, tree("tree-root"), `${REPO}/git/blobs/blob-AGENTS.md`]);
    });

    it("reads nothing at a commit this repository does not hold", async () => {
        const host = fakeHost(repoAt({ "AGENTS.md": "# Rules" }));
        const elsewhere = "d".repeat(40);

        await expect(readRepoRuleFiles(host.request, ADDRESS, elsewhere, picks("AGENTS.md"))).resolves.toStrictEqual([
            { path: "AGENTS.md", status: "missing" },
        ]);
        expect(host.calls).toHaveLength(1);
    });

    it("reads nothing from a repository emptied since its listing, nor a blob the host sends other than as base64", async () => {
        const emptied = fakeHost({ [`${REPO}/git/commits/${COMMIT}`]: new HostApiError("empty", 409) });

        await expect(readRepoRuleFiles(emptied.request, ADDRESS, COMMIT, picks("AGENTS.md"))).resolves.toStrictEqual([
            { path: "AGENTS.md", status: "missing" },
        ]);

        const routes = repoAt({ "AGENTS.md": "# Rules", "CLAUDE.md": "# Other" });

        routes[`${REPO}/git/blobs/blob-AGENTS.md`] = { content: "", encoding: "none" };
        routes[`${REPO}/git/blobs/blob-CLAUDE.md`] = { content: "%%%", encoding: "base64" };

        await expect(readRepoRuleFiles(fakeHost(routes).request, ADDRESS, COMMIT, picks("AGENTS.md", "CLAUDE.md"))).resolves.toStrictEqual([
            { path: "AGENTS.md", status: "missing" },
            { path: "CLAUDE.md", status: "missing" },
        ]);
    });

    it("reads only what the commit's listing offers: never a file of a rules folder it passed over", async () => {
        const { request } = fakeHost(repoAt({ ".rules/a.md": "listed", "rules/b.md": "passed over" }));

        await expect(readRepoRuleFiles(request, ADDRESS, COMMIT, picks(".rules/a.md", "rules/b.md"))).resolves.toStrictEqual([
            { path: ".rules/a.md", status: "ok", text: "listed" },
            { path: "rules/b.md", status: "missing" },
        ]);
    });

    it("reads a link as the listed file its SHA names, never reading the link, and refuses one whose SHA is no listed file's", async () => {
        const host = fakeHost(
            repoAt({ ".env": "SECRET=1", "AGENTS.md": "# Rules", "CLAUDE.md": { link: "AGENTS.md" }, "GEMINI.md": { link: ".env" }, "rules/a.md": "rule" }),
        );

        await expect(
            readRepoRuleFiles(host.request, ADDRESS, COMMIT, [
                { path: "GEMINI.md" },
                // A SHA the listing never gave: the file a link leads outside to.
                { path: "GEMINI.md", sha: sha(".env") },
                { path: "CLAUDE.md", sha: sha("AGENTS.md") },
                // A link may lead to a rules folder's file too.
                { path: "CLAUDE.md", sha: sha("rules/a.md") },
                // A file's own blob only, never another's.
                { path: "AGENTS.md", sha: sha("rules/a.md") },
            ]),
        ).resolves.toStrictEqual([
            { path: "GEMINI.md", status: "refused" },
            { path: "GEMINI.md", status: "refused" },
            { path: "CLAUDE.md", status: "ok", text: "# Rules" },
            { path: "CLAUDE.md", status: "ok", text: "rule" },
            { path: "AGENTS.md", status: "missing" },
        ]);

        const blobs = host.calls.map((call) => call.path).filter((path) => path.includes("/git/blobs/"));

        expect(blobs).not.toContain(`${REPO}/git/blobs/${sha(".env")}`);
        // No link's own blob: the read follows none.
        expect(blobs).toStrictEqual([`${REPO}/git/blobs/${sha("AGENTS.md")}`, `${REPO}/git/blobs/${sha("rules/a.md")}`]);
    });

    it("stops spending at the read budget, still taking a later file that fits", async () => {
        const paths = ["rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"];
        const files: Record<string, FakeFile> = Object.fromEntries(paths.map((path) => [path, { size: REPO_RULE_FILE_MAX_BYTES }]));

        files["rules/d.md"] = "small";

        const reads = await readRepoRuleFiles(fakeHost(repoAt(files)).request, ADDRESS, COMMIT, picks(...paths));
        const fitting = Math.floor(REPO_RULE_FILES_READ_BYTES / REPO_RULE_FILE_MAX_BYTES);

        expect(reads.filter((read) => read.status === "ok")).toHaveLength(fitting + 1);
        expect(reads.at(-1)).toStrictEqual({ path: "rules/d.md", status: "ok", text: "small" });
        expect(reads[fitting]).toStrictEqual({ path: paths[fitting], status: "too_large" });
    });

    it("refuses a file longer than a rule file may be, spending none of the budget on it", async () => {
        const { request } = fakeHost(
            repoAt({
                "rules/a.md": "a".repeat(MAX_RULE_FILE_LENGTH + 1),
                "rules/b.md": { size: REPO_RULE_FILE_MAX_BYTES },
                "rules/c.md": { size: REPO_RULE_FILE_MAX_BYTES },
                "rules/d.md": { size: REPO_RULE_FILES_READ_BYTES - 2 * REPO_RULE_FILE_MAX_BYTES },
            }),
        );

        await expect(readRepoRuleFiles(request, ADDRESS, COMMIT, picks("rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"))).resolves.toStrictEqual([
            { path: "rules/a.md", status: "too_large" },
            { path: "rules/b.md", status: "ok", text: "" },
            { path: "rules/c.md", status: "ok", text: "" },
            { path: "rules/d.md", status: "ok", text: "" },
        ]);
    });

    it("counts a folder file's length without its byte-order mark and front matter, as the import does, and a root file's whole", async () => {
        const frontMatter = `---\ndescription: ${"d".repeat(200)}\n---\n`;
        const body = "b".repeat(MAX_RULE_FILE_LENGTH);
        const { request } = fakeHost(
            repoAt({
                "AGENTS.md": `${frontMatter}${body}`,
                "rules/long.md": `\u{FEFF}${frontMatter}${body}b`,
                "rules/near.md": `\u{FEFF}${frontMatter}${body}`,
            }),
        );

        await expect(readRepoRuleFiles(request, ADDRESS, COMMIT, picks("rules/near.md", "rules/long.md", "AGENTS.md"))).resolves.toStrictEqual([
            // The decoder drops the mark.
            { path: "rules/near.md", status: "ok", text: `${frontMatter}${body}` },
            { path: "rules/long.md", status: "too_large" },
            { path: "AGENTS.md", status: "too_large" },
        ]);
    });

    it("refuses a file past the byte limit without reading it", async () => {
        const host = fakeHost(repoAt({ "AGENTS.md": { size: REPO_RULE_FILE_MAX_BYTES + 1 } }));

        await expect(readRepoRuleFiles(host.request, ADDRESS, COMMIT, picks("AGENTS.md"))).resolves.toStrictEqual([{ path: "AGENTS.md", status: "too_large" }]);
        expect(host.calls.map((call) => call.path)).not.toContain(`${REPO}/git/blobs/blob-AGENTS.md`);
    });
});

describe(fetchBudget, () => {
    /** Subrequests a Worker request may make on the Free plan. */
    const SUBREQUEST_CAP = 50;
    /**
     * What an import action asks of the backend besides the host, at most: the session and rate-limit checks (2 each),
     * the repository and grant lookups, a token refresh's call and store (and its re-read on a refused grant), and a
     * 401's forced refresh (the grant again, the call, the store, the re-read).
     */
    const ACTION_CALLS = 14;

    /** `request`, counting what reaches it, and answering the `at`-th with a 401 (the token refused), once. */
    const refusedOnceAt = (request: HostRequest, at: number) => {
        let count = 0;

        return {
            count: () => count,
            request: (async (path, options) => {
                count += 1;

                if (count === at) {
                    throw new HostApiError("Bad credentials", 401);
                }

                return request(path, options);
            }) satisfies HostRequest,
        };
    };

    /**
     * The widest a listing or read walks: three rules folders looked in (`.agents/rules` through `.agents`), the last
     * holding `count` links to the root `AGENTS.md`.
     */
    const widest = (count: number) => {
        const links = Array.from({ length: count }, (_, index) => `.agents/rules/l${String(index).padStart(2, "0")}.md`);
        const routes = repoAt({
            ".rules/notes.txt": "x",
            "AGENTS.md": "# Rules",
            "rules/notes.txt": "x",
            ...Object.fromEntries(links.map((path) => [path, { link: "../../AGENTS.md" }])),
        });
        const root = routes[tree("tree-root")] as { tree: unknown[] };

        root.tree.push(folder(".agents"));
        routes[tree("tree-.agents")] = { tree: [{ mode: "040000", path: "rules", sha: "tree-agents-rules", type: "tree" }] };
        routes[tree("tree-agents-rules")] = routes[tree("tree-.agents/rules")];

        return { links, routes: { ...routes, [`${REPO}/commits`]: commits } };
    };

    it("keeps an import action under the Worker's subrequest cap with room to spare", () => {
        expect(HOST_FETCHES_PER_IMPORT + ACTION_CALLS).toBeLessThanOrEqual(SUBREQUEST_CAP - 8);
    });

    it("reads 20 picked links without a 401 in full, and after one partway reads what is left, the rest not read", async () => {
        const { links, routes } = widest(20);
        const picked = links.map((path) => {
            return { path, sha: sha("AGENTS.md") };
        });
        const whole = refusedOnceAt(fakeHost(routes).request, 0);

        const all = await readRepoRuleFiles(fetchBudget()(whole.request), ADDRESS, COMMIT, picked);

        expect(new Set(all.map((read) => read.status))).toStrictEqual(new Set(["ok"]));
        expect(whole.count()).toBeLessThanOrEqual(HOST_FETCHES_PER_IMPORT);

        // As `readFromHost` does: one budget, the whole read once more after the 401.
        const budgeted = fetchBudget();
        const host = refusedOnceAt(fakeHost(routes).request, 15);

        await expect(readRepoRuleFiles(budgeted(host.request), ADDRESS, COMMIT, picked)).rejects.toMatchObject({ status: 401 });

        const reads = await readRepoRuleFiles(budgeted(host.request), ADDRESS, COMMIT, picked);

        expect(host.count()).toBe(HOST_FETCHES_PER_IMPORT);
        expect(reads.filter((read) => read.status === "ok")).toHaveLength(HOST_FETCHES_PER_IMPORT - 15 - 6);
        expect(reads.filter((read) => read.status === "not_read").map((read) => read.path)).toStrictEqual(links.slice(HOST_FETCHES_PER_IMPORT - 15 - 6));
        // Nothing more is sent once it is spent.
        const after = await readRepoRuleFiles(budgeted(host.request), ADDRESS, COMMIT, picked);

        expect(new Set(after.map((read) => read.status))).toStrictEqual(new Set(["not_read"]));
        expect(host.count()).toBe(HOST_FETCHES_PER_IMPORT);
    });

    it("lists 20 links after a 401 at the listing's last request, refusing the links it has no requests left for", async () => {
        const { links, routes } = widest(20);
        const budgeted = fetchBudget();
        const whole = refusedOnceAt(fakeHost(routes).request, 0);
        const first = await listRepoRuleFiles(budgeted(whole.request), ADDRESS);

        expect(first.files.filter((file) => file.refused === "budget")).toHaveLength(links.length - MAX_LINKS_FOLLOWED);

        const host = refusedOnceAt(fakeHost(routes).request, whole.count());
        const retried = fetchBudget();

        await expect(listRepoRuleFiles(retried(host.request), ADDRESS)).rejects.toMatchObject({ status: 401 });

        const listing = await listRepoRuleFiles(retried(host.request), ADDRESS);

        expect(host.count()).toBeLessThanOrEqual(HOST_FETCHES_PER_IMPORT);
        expect(listing.files.find((file) => file.path === "AGENTS.md")).toMatchObject({ sha: sha("AGENTS.md") });
        expect(listing.files.filter((file) => file.refused === "budget").map((file) => file.path)).toStrictEqual(links);
    });
});
