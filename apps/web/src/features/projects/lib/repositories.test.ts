import { describe, expect, it } from "vitest";

import { repoLabel, repoLabels, storedRepoUrl } from "./repositories";

describe("repoLabel", () => {
    it("names a GitHub repository owner/repo and any other by host and path", () => {
        expect(repoLabel("https://github.com/acme/web.git")).toBe("acme/web");
        expect(repoLabel("https://git.example.com/team/api.git")).toBe("git.example.com/team/api");
        expect(repoLabel("https://git.example.com:8443/team/api.git")).toBe("git.example.com:8443/team/api");
        expect(repoLabel("not a url")).toBe("not a url");
    });

    it("names two entries that share a label by their full URL", () => {
        expect(repoLabels(["https://git.example.com/api", "https://git.example.com/api.git", "https://github.com/acme/web.git"])).toStrictEqual([
            "https://git.example.com/api",
            "https://git.example.com/api.git",
            "acme/web",
        ]);
    });
});

describe("storedRepoUrl", () => {
    it.each([
        ["acme/web", "https://github.com/acme/web.git"],
        ["https://github.com/acme/web", "https://github.com/acme/web.git"],
        ["https://github.com/acme/web.git/", "https://github.com/acme/web.git"],
        [" https://www.GitHub.com/acme/web.git ", "https://github.com/acme/web.git"],
        ["https://git.example.com/team/api.git", "https://git.example.com/team/api.git"],
        ["acme", undefined],
        // What the backend refuses never matches a listed repository.
        ["https://github.com/acme/web?x=1", undefined],
        ["https://github.com/acme/web#readme", undefined],
        ["https://user:secret@git.example.com/team/api.git", undefined],
        // eslint-disable-next-line unicorn/prefer-https -- a plain-http URL is the case under test
        ["http://git.example.com/team/api.git", undefined],
        ["https://github.com/acme/web/tree/main", undefined],
    ])("matches %s as the backend stores it", (typed, stored) => {
        expect(storedRepoUrl(typed)).toBe(stored);
    });
});
