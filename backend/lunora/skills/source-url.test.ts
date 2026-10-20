import { describe, expect, it } from "vitest";

import { resolveSkillSourceUrls } from "./source-url";

const RAW = "https://raw.githubusercontent.com";

const urls = (pasted: string): string[] => {
    const result = resolveSkillSourceUrls(pasted);

    if (!result.ok) {
        throw new Error(result.error);
    }

    return result.urls;
};

const refused = (pasted: string): string => {
    const result = resolveSkillSourceUrls(pasted);

    return result.ok ? "" : result.error;
};

describe("GitHub links", () => {
    it("reads a SKILL.md blob link", () => {
        expect(urls("https://github.com/acme/skills/blob/main/pdf/SKILL.md")).toStrictEqual([`${RAW}/acme/skills/main/pdf/SKILL.md`]);
    });

    it("reads a folder (tree) link and a repository root", () => {
        expect(urls("https://github.com/acme/skills/tree/v1.2/skills/pdf")).toStrictEqual([`${RAW}/acme/skills/v1.2/skills/pdf/SKILL.md`]);
        expect(urls("https://github.com/acme/skills")).toStrictEqual([`${RAW}/acme/skills/HEAD/SKILL.md`]);
    });

    it("ignores a query string and a fragment", () => {
        expect(urls("https://github.com/acme/skills/blob/main/SKILL.md?plain=1#L3")).toStrictEqual([`${RAW}/acme/skills/main/SKILL.md`]);
    });

    it("refuses other GitHub pages", () => {
        expect(refused("https://github.com/acme/skills/issues/3")).not.toBe("");
        expect(refused("https://github.com/acme")).not.toBe("");
    });
});

describe("raw links", () => {
    it("accepts a raw SKILL.md and nothing else", () => {
        expect(urls(`${RAW}/acme/skills/main/pdf/SKILL.md`)).toStrictEqual([`${RAW}/acme/skills/main/pdf/SKILL.md`]);
        expect(refused(`${RAW}/acme/skills/main/pdf/notes.md`)).not.toBe("");
        expect(refused(`${RAW}/acme/skills/main/.env`)).not.toBe("");
    });
});

describe("skills.sh links", () => {
    it("maps owner/repo/skill to the usual repository layouts, in order", () => {
        expect(urls("https://skills.sh/acme/skills/pdf")).toStrictEqual([
            `${RAW}/acme/skills/HEAD/skills/pdf/SKILL.md`,
            `${RAW}/acme/skills/HEAD/pdf/SKILL.md`,
            `${RAW}/acme/skills/HEAD/.claude/skills/pdf/SKILL.md`,
        ]);
    });

    it("refuses a listing page or a site-hosted skill, which are not in GitHub", () => {
        expect(refused("https://skills.sh/")).not.toBe("");
        expect(refused("https://skills.sh/site/open.feishu.cn/lark-doc")).not.toBe("");
    });
});

describe("what is never fetched", () => {
    it.each([
        ["another host", "https://evil.example/acme/skills/main/SKILL.md"],
        ["a lookalike host", "https://github.com.evil.example/acme/skills"],
        ["a subdomain", "https://gist.github.com/acme/skills"],
        // eslint-disable-next-line unicorn/prefer-https -- the case under test
        ["plain http", "http://github.com/acme/skills"],
        ["credentials", "https://user:pass@github.com/acme/skills"], // secret-scanner:allow a fake credential in the URL, the case under test
        ["a port", "https://github.com:8443/acme/skills"],
        ["an IP literal", "https://127.0.0.1/acme/skills/main/SKILL.md"],
        ["an internal name", "https://localhost/acme/skills"],
        ["a metadata address", "https://169.254.169.254/latest/meta-data"],
        ["another scheme", "file:///etc/passwd"],
        ["not a link", "acme/skills"],
    ])("refuses %s", (_label, pasted) => {
        expect(refused(pasted)).not.toBe("");
    });

    it.each([
        "https://github.com/acme/skills/blob/main/a%2Fb/SKILL.md",
        "https://github.com/acme/skills/blob/main/a b/SKILL.md",
        "https://github.com/acme/skills/blob/..%2f..%2f/SKILL.md",
    ])("refuses a path that hides a separator: %s", (pasted) => {
        expect(refused(pasted)).not.toBe("");
    });

    // The URL parser resolves `..` and `%2e%2e` before the resolver sees the path, so these either read as a
    // different, harmless location or are refused. What must hold is that no built URL can climb or leave the host.
    it.each([
        "https://github.com/acme/skills/blob/main/../../../etc/SKILL.md",
        "https://github.com/acme/skills/blob/main/%2e%2e/SKILL.md",
        "https://github.com/acme/skills/blob/main/%2e%2e/%2e%2e/SKILL.md",
    ])("builds nothing that climbs: %s", (pasted) => {
        const result = resolveSkillSourceUrls(pasted);
        const built = result.ok ? result.urls : [];

        for (const url of built) {
            expect(new URL(url).host).toBe("raw.githubusercontent.com");
            expect(url).not.toContain("..");
            expect(url).not.toContain("%");
        }
    });

    it("never builds a URL outside raw.githubusercontent.com", () => {
        const pastedLinks = ["https://github.com/acme/skills", "https://skills.sh/acme/skills/pdf", `${RAW}/acme/skills/main/SKILL.md`];
        const built = pastedLinks.flatMap((pasted) => urls(pasted));

        for (const url of built) {
            expect(new URL(url).host).toBe("raw.githubusercontent.com");
        }
    });
});
