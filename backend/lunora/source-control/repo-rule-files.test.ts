import { describe, expect, it } from "vitest";

import { HostApiError } from "./origin-fetch";
import type { HostRequest } from "./origin-fetch";
import { MAX_RULE_FILE_LENGTH } from "../projects/rule-file-limits";
import {
    CONTENTS_LIST_LIMIT,
    isImportablePath,
    listRepoRuleFiles,
    readRepoRuleFiles,
    REPO_RULE_FILE_MAX_BYTES,
    REPO_RULE_FILES_READ_BYTES,
} from "./repo-rule-files";

const ADDRESS = { name: "hello", owner: "octo", ref: "main" };
const BASE = "/repos/octo/hello/contents";

/** A host answering each path from `routes`, recording the paths and queries asked. */
const fakeHost = (routes: Record<string, unknown>): { calls: { path: string; query: unknown }[]; request: HostRequest } => {
    const calls: { path: string; query: unknown }[] = [];
    const request: HostRequest = async (path, options) => {
        calls.push({ path, query: options?.query });

        if (!(path in routes)) {
            throw new HostApiError("missing", 404);
        }

        return Response.json(routes[path]);
    };

    return { calls, request };
};

const file = (name: string, size = 10, folder = "") => {
    return { name, path: folder ? `${folder}/${name}` : name, size, type: "file" };
};

const encoded = (text: string) => {
    const bytes = new TextEncoder().encode(text);

    return { content: btoa(String.fromCodePoint(...bytes)), encoding: "base64", size: bytes.byteLength, type: "file" };
};

describe(listRepoRuleFiles, () => {
    it("lists the root instruction files in any case and the first rules folder's Markdown files", async () => {
        const { calls, request } = fakeHost({
            [`${BASE}/rules`]: [file("sql.md", 10, "rules"), file("notes.txt", 10, "rules"), { name: "nested", path: "rules/nested", type: "dir" }],
            [BASE]: [file("AGENTS.md"), file("claude.md"), file("README.md"), { name: "rules", path: "rules", type: "dir" }],
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toStrictEqual([
            { path: "AGENTS.md", size: 10, tooLarge: false },
            { path: "claude.md", size: 10, tooLarge: false },
            { path: "rules/sql.md", size: 10, tooLarge: false },
        ]);
        expect(calls).toStrictEqual([
            { path: BASE, query: { ref: "main" } },
            { path: `${BASE}/rules`, query: { ref: "main" } },
        ]);
    });

    it("passes over a rules folder without Markdown to the next, and lists no hidden file", async () => {
        const { calls, request } = fakeHost({
            [`${BASE}/.rules`]: [file("notes.txt", 10, ".rules")],
            [`${BASE}/rules`]: [file(".draft.md", 10, "rules"), file("style.md", 10, "rules")],
            [BASE]: [
                { name: ".rules", path: ".rules", type: "dir" },
                { name: "rules", path: "rules", type: "dir" },
            ],
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toStrictEqual([{ path: "rules/style.md", size: 10, tooLarge: false }]);
        expect(calls.map((call) => call.path)).toStrictEqual([BASE, `${BASE}/.rules`, `${BASE}/rules`]);
    });

    it("asks for no folder the root does not hold, and marks a file past the limit", async () => {
        const { calls, request } = fakeHost({ [BASE]: [file("GEMINI.md", REPO_RULE_FILE_MAX_BYTES + 1)] });

        await expect(listRepoRuleFiles(request, { name: "hello", owner: "octo" })).resolves.toStrictEqual([
            { path: "GEMINI.md", size: REPO_RULE_FILE_MAX_BYTES + 1, tooLarge: true },
        ]);
        expect(calls).toStrictEqual([{ path: BASE, query: {} }]);
    });

    it("lists a folder the contents API cuts at its limit from its git tree, symlinks as files", async () => {
        const filler = Array.from({ length: CONTENTS_LIST_LIMIT }, (_, index) => file(`a${String(index)}.txt`));
        const { calls, request } = fakeHost({
            [`${BASE}/rules`]: filler,
            [`/repos/octo/hello/git/trees/${encodeURIComponent("main:")}`]: {
                tree: [
                    { mode: "100644", path: "zz.txt", size: 1, type: "blob" },
                    { mode: "120000", path: "CLAUDE.md", size: 9, type: "blob" },
                    { mode: "040000", path: "rules", type: "tree" },
                ],
                truncated: false,
            },
            [`/repos/octo/hello/git/trees/${encodeURIComponent("main:rules")}`]: { tree: [{ mode: "100644", path: "sql.md", size: 5, type: "blob" }] },
            [BASE]: filler,
        });

        await expect(listRepoRuleFiles(request, ADDRESS)).resolves.toStrictEqual([
            { path: "CLAUDE.md", size: 9, tooLarge: false },
            { path: "rules/sql.md", size: 5, tooLarge: false },
        ]);
        expect(calls.map((call) => call.path)).toStrictEqual([
            BASE,
            `/repos/octo/hello/git/trees/${encodeURIComponent("main:")}`,
            `${BASE}/rules`,
            `/repos/octo/hello/git/trees/${encodeURIComponent("main:rules")}`,
        ]);
    });

    it("lists the default branch's tree when no branch is named", async () => {
        const filler = Array.from({ length: CONTENTS_LIST_LIMIT }, (_, index) => file(`a${String(index)}.txt`));
        const { request } = fakeHost({
            [`/repos/octo/hello/git/trees/${encodeURIComponent("HEAD:")}`]: { tree: [{ path: "AGENTS.md", size: 3, type: "blob" }] },
            [BASE]: filler,
        });

        await expect(listRepoRuleFiles(request, { name: "hello", owner: "octo" })).resolves.toStrictEqual([{ path: "AGENTS.md", size: 3, tooLarge: false }]);
    });

    it("passes on a host failure of the root listing", async () => {
        const { request } = fakeHost({});

        await expect(listRepoRuleFiles(request, ADDRESS)).rejects.toBeInstanceOf(HostApiError);
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
        const { request } = fakeHost({ [`${BASE}/AGENTS.md`]: encoded("# Règles\nUse pnpm.") });

        await expect(readRepoRuleFiles(request, ADDRESS, ["AGENTS.md", "CLAUDE.md"])).resolves.toStrictEqual([
            { path: "AGENTS.md", status: "ok", text: "# Règles\nUse pnpm." },
            { path: "CLAUDE.md", status: "missing" },
        ]);
    });

    it("stops spending at the read budget, still taking a later file that fits", async () => {
        const big = { content: "", encoding: "base64", size: REPO_RULE_FILE_MAX_BYTES, type: "file" };
        const paths = ["rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"];
        const routes: Record<string, unknown> = Object.fromEntries(paths.map((path) => [`${BASE}/${path}`, big]));

        routes[`${BASE}/rules/d.md`] = encoded("small");

        const reads = await readRepoRuleFiles(fakeHost(routes).request, ADDRESS, paths);
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

        await expect(readRepoRuleFiles(request, ADDRESS, ["rules/a.md", "rules/b.md", "rules/c.md", "rules/d.md"])).resolves.toStrictEqual([
            { path: "rules/a.md", status: "too_large" },
            { path: "rules/b.md", status: "ok", text: "" },
            { path: "rules/c.md", status: "ok", text: "" },
            { path: "rules/d.md", status: "ok", text: "" },
        ]);
    });

    it("refuses a file the host will not send whole", async () => {
        const { request } = fakeHost({ [`${BASE}/AGENTS.md`]: { content: "", encoding: "none", size: 2_000_000, type: "file" } });

        await expect(readRepoRuleFiles(request, ADDRESS, ["AGENTS.md"])).resolves.toStrictEqual([{ path: "AGENTS.md", status: "too_large" }]);
    });
});
