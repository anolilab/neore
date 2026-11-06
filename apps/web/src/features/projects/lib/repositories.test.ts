import { describe, expect, it } from "vitest";

import { defaultRepoOf, repoLabel, withDefault } from "./repositories";

describe("repoLabel", () => {
    it("names a GitHub repository owner/repo and any other by host and path", () => {
        expect(repoLabel("https://github.com/acme/web.git")).toBe("acme/web");
        expect(repoLabel("https://git.example.com/team/api.git")).toBe("git.example.com/team/api");
        expect(repoLabel("not a url")).toBe("not a url");
    });
});

describe("defaultRepoOf / withDefault", () => {
    const repositories = [
        { id: "a", url: "https://github.com/acme/web.git" },
        { id: "b", isDefault: true, url: "https://github.com/acme/api.git" },
    ];

    it("preselects the marked default, else the first", () => {
        expect(defaultRepoOf(repositories)?.id).toBe("b");
        expect(defaultRepoOf([repositories[0]!])?.id).toBe("a");
        expect(defaultRepoOf(undefined)).toBeUndefined();
    });

    it("moves the default to one entry", () => {
        expect(withDefault(repositories, "a").map((repo) => repo.isDefault === true)).toStrictEqual([true, false]);
    });
});
