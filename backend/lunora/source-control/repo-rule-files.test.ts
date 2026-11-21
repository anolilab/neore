import { describe, expect, it } from "vitest";

import { HostApiError } from "./origin-fetch";
import type { HostRequest } from "./origin-fetch";
import { MAX_RULE_FILE_LENGTH } from "../projects/rule-file-limits";
import { isImportablePath, listRepoRuleFiles, readRepoRuleFiles, REPO_RULE_FILE_MAX_BYTES, REPO_RULE_FILES_READ_BYTES } from "./repo-rule-files";

const ADDRESS = { name: "hello", owner: "octo", ref: "main" };
const REPO = "/repos/octo/hello";
const BASE = `${REPO}/contents`;
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

const encoded = (text: string) => {
    const bytes = new TextEncoder().encode(text);

    return { content: btoa(String.fromCodePoint(...bytes)), encoding: "base64", size: bytes.byteLength, type: "file" };
};

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
                { path: "AGENTS.md", size: 10, tooLarge: false },
                { path: "claude.md", size: 10, tooLarge: false },
                { path: "rules/sql.md", size: 10, tooLarge: false },
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
            files: [{ path: ".agents/rules/style.md", size: 10, tooLarge: false }],
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

    it("asks for no folder the root does not hold, lists a symlink as a file, and marks a file past the limit", async () => {
        const { calls, request } = fakeHost({
            [`${REPO}/commits`]: commits,
            [tree("tree-root")]: {
                tree: [blob("GEMINI.md", REPO_RULE_FILE_MAX_BYTES + 1), { mode: "120000", path: "CLAUDE.md", sha: "s", size: 9, type: "blob" }],
            },
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toStrictEqual({
            commit: COMMIT,
            files: [
                { path: "CLAUDE.md", size: 9, tooLarge: false },
                { path: "GEMINI.md", size: REPO_RULE_FILE_MAX_BYTES + 1, tooLarge: true },
            ],
            truncated: false,
        });
        expect(calls).toHaveLength(2);
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

describe(readRepoRuleFiles, () => {
    it("decodes each file as UTF-8 and says which are gone", async () => {
        const host = fakeHost({ [`${BASE}/AGENTS.md`]: encoded("# Règles\nUse pnpm.") });
        const { calls } = host;

        await expect(readRepoRuleFiles(host.request, ADDRESS, COMMIT, ["AGENTS.md", "CLAUDE.md"])).resolves.toStrictEqual([
            { path: "AGENTS.md", status: "ok", text: "# Règles\nUse pnpm." },
            { path: "CLAUDE.md", status: "missing" },
        ]);
        // At the listing's commit, never the branch: a branch moved since would give other files.
        expect(calls.map((call) => call.query)).toStrictEqual([{ ref: COMMIT }, { ref: COMMIT }]);
    });

    it("stops spending at the read budget, still taking a later file that fits", async () => {
        const big = { content: "", encoding: "base64", size: REPO_RULE_FILE_MAX_BYTES, type: "file" };
        const paths = ["rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"];
        const routes: Record<string, unknown> = Object.fromEntries(paths.map((path) => [`${BASE}/${path}`, big]));

        routes[`${BASE}/rules/d.md`] = encoded("small");

        const reads = await readRepoRuleFiles(fakeHost(routes).request, ADDRESS, COMMIT, paths);
        const fitting = Math.floor(REPO_RULE_FILES_READ_BYTES / REPO_RULE_FILE_MAX_BYTES);

        expect(reads.filter((read) => read.status === "ok")).toHaveLength(fitting + 1);
        expect(reads.at(-1)).toStrictEqual({ path: "rules/d.md", status: "ok", text: "small" });
        expect(reads[fitting]).toStrictEqual({ path: paths[fitting], status: "too_large" });
    });

    it("refuses a file longer than a rule file may be, spending none of the budget on it", async () => {
        const sized = (size: number) => {
            return { content: "", encoding: "base64", size, type: "file" };
        };
        const { request } = fakeHost({
            [`${BASE}/rules/a.md`]: encoded("a".repeat(MAX_RULE_FILE_LENGTH + 1)),
            [`${BASE}/rules/b.md`]: sized(REPO_RULE_FILE_MAX_BYTES),
            [`${BASE}/rules/c.md`]: sized(REPO_RULE_FILE_MAX_BYTES),
            [`${BASE}/rules/d.md`]: sized(REPO_RULE_FILES_READ_BYTES - 2 * REPO_RULE_FILE_MAX_BYTES),
        });

        await expect(readRepoRuleFiles(request, ADDRESS, COMMIT, ["rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"])).resolves.toStrictEqual([
            { path: "rules/a.md", status: "too_large" },
            { path: "rules/b.md", status: "ok", text: "" },
            { path: "rules/c.md", status: "ok", text: "" },
            { path: "rules/d.md", status: "ok", text: "" },
        ]);
    });

    it("counts a folder file's length without its byte-order mark and front matter, as the import does, and a root file's whole", async () => {
        const frontMatter = `---\ndescription: ${"d".repeat(200)}\n---\n`;
        const body = "b".repeat(MAX_RULE_FILE_LENGTH);
        const { request } = fakeHost({
            [`${BASE}/AGENTS.md`]: encoded(`${frontMatter}${body}`),
            [`${BASE}/rules/long.md`]: encoded(`\u{FEFF}${frontMatter}${body}b`),
            [`${BASE}/rules/near.md`]: encoded(`\u{FEFF}${frontMatter}${body}`),
        });

        await expect(readRepoRuleFiles(request, ADDRESS, COMMIT, ["rules/near.md", "rules/long.md", "AGENTS.md"])).resolves.toStrictEqual([
            // The decoder drops the mark.
            { path: "rules/near.md", status: "ok", text: `${frontMatter}${body}` },
            { path: "rules/long.md", status: "too_large" },
            { path: "AGENTS.md", status: "too_large" },
        ]);
    });

    it("refuses a file the host will not send whole", async () => {
        const { request } = fakeHost({ [`${BASE}/AGENTS.md`]: { content: "", encoding: "none", size: 2_000_000, type: "file" } });

        await expect(readRepoRuleFiles(request, ADDRESS, COMMIT, ["AGENTS.md"])).resolves.toStrictEqual([{ path: "AGENTS.md", status: "too_large" }]);
    });
});
