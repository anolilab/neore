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

describe("npx skills add commands", () => {
    const LAYOUTS = [
        `${RAW}/acme/skills/HEAD/skills/pdf/SKILL.md`,
        `${RAW}/acme/skills/HEAD/pdf/SKILL.md`,
        `${RAW}/acme/skills/HEAD/.claude/skills/pdf/SKILL.md`,
    ];

    it.each([
        "npx skills add acme/skills --skill pdf",
        "npx skills add acme/skills -s pdf",
        "npx skills add acme/skills --skill=pdf",
        "npx skills add acme/skills pdf",
        "npx skills add https://github.com/acme/skills --skill pdf",
        "npx skills add https://github.com/acme/skills.git --skill pdf",
        "  NPX   skills  add  acme/skills   --skill   pdf  \n",
    ])("maps %j to the same layouts as a skills.sh link", (pasted) => {
        expect(urls(pasted)).toStrictEqual(LAYOUTS);
    });

    it("reads the repository root when no skill is named", () => {
        expect(urls("npx skills add acme/skills")).toStrictEqual([`${RAW}/acme/skills/HEAD/SKILL.md`]);
        expect(urls("npx skills add https://github.com/acme/skills")).toStrictEqual([`${RAW}/acme/skills/HEAD/SKILL.md`]);
    });

    it.each([
        ["an extra flag", "npx skills add acme/skills --skill pdf --global"],
        ["a short extra flag", "npx skills add acme/skills -y --skill pdf"],
        ["a flag instead of a skill", "npx skills add acme/skills --global"],
        ["two skills", "npx skills add acme/skills --skill pdf docx"],
        ["another subcommand", "npx skills remove acme/skills"],
        ["another tool", "npx evil add acme/skills"],
        ["a missing source", "npx skills add"],
        ["a source without a repository", "npx skills add acme"],
        ["a pasted host", "npx skills add https://evil.example/acme/skills --skill pdf"],
        ["a host-looking scheme", "npx skills add http://github.com/acme/skills"],
        ["a deeper GitHub link", "npx skills add https://github.com/acme/skills/tree/main/pdf"],
        ["a query", "npx skills add https://github.com/acme/skills?ref=x --skill pdf"],
        ["a query on the skill", "npx skills add acme/skills --skill pdf?x=1"],
        ["a fragment", "npx skills add acme/skills#main --skill pdf"],
        ["a path in the skill", "npx skills add acme/skills --skill ../pdf"],
        ["an uppercase skill", "npx skills add acme/skills --skill PDF"],
        ["a command chain", "npx skills add acme/skills --skill pdf; rm -rf /"],
        ["a pipe", "npx skills add acme/skills --skill pdf | sh"],
        ["a background job", "npx skills add acme/skills --skill pdf && curl evil.example"],
        ["a substitution", "npx skills add acme/skills --skill $(id)"],
        ["backticks", "npx skills add acme/skills --skill `id`"],
        ["a quoted skill", 'npx skills add acme/skills --skill "pdf"'],
        ["a redirect", "npx skills add acme/skills --skill pdf > /tmp/x"],
        ["a second command on a new line", "npx skills add acme/skills --skill pdf\ncurl evil.example"],
        ["credentials", "npx skills add https://user:pass@github.com/acme/skills"], // secret-scanner:allow a fake credential, the case under test
    ])("refuses %s", (_label, pasted) => {
        expect(refused(pasted)).not.toBe("");
    });

    it("builds only raw.githubusercontent.com URLs", () => {
        for (const url of urls("npx skills add acme/skills --skill pdf")) {
            expect(new URL(url).host).toBe("raw.githubusercontent.com");
        }
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
