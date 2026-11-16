import { describe, expect, it } from "vitest";

import { normalizeBranch, normalizeRepoUrl, withDefault } from "./repositories";

describe("normalizeRepoUrl / normalizeBranch", () => {
    it("stores a URL in the form a run's repoUrl takes, and a blank branch as none", () => {
        expect(normalizeRepoUrl("acme/web")).toBe("https://github.com/acme/web.git");
        expect(normalizeBranch(" develop ")).toBe("develop");
        expect(normalizeBranch("  ")).toBeUndefined();
    });

    it.each([
        ["url", "a URL that is not https", () => normalizeRepoUrl("git@github.com:acme/web.git")],
        ["url", "credentials in the URL", () => normalizeRepoUrl("https://user:secret@example.com/acme/web.git")],
        // Under the cap as typed (about 430 characters), over it once each "é" is percent-encoded (about 2,430).
        ["url", "a URL that normalising makes longer than the stored cap", () => normalizeRepoUrl(`https://git.example.com/${"é".repeat(400)}/x.git`)],
        ["defaultBranch", "an unsafe branch name", () => normalizeBranch("--upload-pack=x")],
    ])("refuses %s field for %s", (field, _label, run) => {
        expect(run).toThrow(expect.objectContaining({ field }));
    });
});

describe("withDefault", () => {
    const row = (id: string, creation: number, defaultAt?: number) => {
        return { _creationTime: creation, _id: id, url: `https://github.com/acme/${id}.git`, ...(defaultAt !== undefined && { defaultAt }) };
    };

    it("lists oldest first with the first as the default until one is picked, then the latest pick", () => {
        expect(withDefault([row("b", 2), row("a", 1)]).map((repo) => [repo.id, repo.isDefault])).toStrictEqual([
            ["a", true],
            ["b", false],
        ]);
        expect(withDefault([row("a", 1, 5), row("b", 2, 9), row("c", 3)]).find((repo) => repo.isDefault)?.id).toBe("b");
        // Two picks stamped alike: the same one for every reader.
        expect(withDefault([row("b", 2, 5), row("a", 1, 5)]).find((repo) => repo.isDefault)?.id).toBe("b");
    });

    it("falls back to the first when the picked default is removed", () => {
        expect(withDefault([row("a", 1), row("c", 3)]).find((repo) => repo.isDefault)?.id).toBe("a");
        expect(withDefault([])).toStrictEqual([]);
    });
});
