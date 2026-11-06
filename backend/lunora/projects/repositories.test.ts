import { describe, expect, it } from "vitest";

import { defaultProjectRepo, MAX_PROJECT_REPOSITORIES, normalizeProjectRepositories, ProjectRepoError } from "./repositories";

const NOW = 1_700_000_000_000;

describe("normalizeProjectRepositories", () => {
    it("stores URLs in the form a run's repoUrl takes, and makes the first the default when none is marked", () => {
        expect(normalizeProjectRepositories([{ url: "acme/web" }, { defaultBranch: " develop ", url: "https://github.com/acme/api" }], NOW)).toStrictEqual([
            { id: `repo_${NOW.toString(36)}0`, isDefault: true, url: "https://github.com/acme/web.git" },
            { defaultBranch: "develop", id: `repo_${NOW.toString(36)}1`, url: "https://github.com/acme/api.git" },
        ]);
    });

    it("keeps an entry's id across edits and keeps one marked default", () => {
        const result = normalizeProjectRepositories(
            [
                { id: "repo_a", url: "acme/web" },
                { id: "repo_b", isDefault: true, url: "acme/api" },
                { isDefault: true, url: "acme/docs" },
            ],
            NOW,
        );

        expect(result.map((repo) => [repo.id, repo.isDefault === true])).toStrictEqual([
            ["repo_a", false],
            ["repo_b", true],
            [`repo_${NOW.toString(36)}2`, false],
        ]);
        expect(defaultProjectRepo(result)?.id).toBe("repo_b");
    });

    it.each([
        ["a duplicate repository", [{ url: "acme/web" }, { url: "https://github.com/acme/web.git" }]],
        ["a URL that is not https", [{ url: "git@github.com:acme/web.git" }]],
        ["credentials in the URL", [{ url: "https://user:secret@example.com/acme/web.git" }]],
        ["an unsafe branch name", [{ defaultBranch: "--upload-pack=x", url: "acme/web" }]],
        ["more than the limit", Array.from({ length: MAX_PROJECT_REPOSITORIES + 1 }, (_, index) => {return { url: `acme/repo${String(index)}` }})],
    ])("refuses %s", (_label, input) => {
        expect(() => normalizeProjectRepositories(input, NOW)).toThrow(ProjectRepoError);
    });

    it("takes an empty list, which clears the repositories", () => {
        expect(normalizeProjectRepositories([], NOW)).toStrictEqual([]);
        expect(defaultProjectRepo([])).toBeUndefined();
    });
});
