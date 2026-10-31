import { describe, expect, it } from "vitest";

import type { Bundle, BundleGroup, BundleItem, BundleTrigger } from "./bundle-format";
import { BUNDLE_LIMITS, buildBundleMarkdown, groupItemOf, parseBundleMarkdown, skillItemOf, triggerItemOf } from "./bundle-format";
import type { SkillMarkdownData } from "./markdown";

const OPENING_FENCE_RE = /^`{3,}markdown$/;
const RE_1 = /version/i;
const RE_2 = /KB/;
const RE_3 = /at most/;
const RE_4 = /event/i;
const RE_5 = /paper-summary/;
const RE_6 = /secret|url|webhook\/|https?:/i;

const SKILL: SkillMarkdownData = {
    category: "research",
    config: { additionalTools: ["webSearch"], preferredModel: "anthropic/claude-sonnet-5", reasoningEffort: 2, searchMode: "deep" },
    description: "Summarise a paper.",
    icon: "📄",
    instructions: "# Steps\n\n1. Read it.\n2. Summarise it.",
    name: "Paper Summary",
    slug: "paper-summary",
    tags: ["papers"],
    variables: [{ description: "Who reads it", name: "AUDIENCE", required: true }],
    version: "1.0.0",
};

const SCHEDULE: BundleTrigger = {
    cronExpression: "0 9 * * 1",
    description: "Monday digest",
    inputTemplate: "Summarise last week",
    model: "gpt-5",
    name: "Weekly digest",
    systemPrompt: "Be brief.",
    timezone: "Europe/Berlin",
    type: "schedule",
};

const WEBHOOK: BundleTrigger = {
    filters: [{ op: "equals", path: "action", value: "opened" }],
    model: "gpt-5",
    name: "On PR",
    type: "webhook",
    webhookSignatureScheme: "native",
};

const GROUP: BundleGroup = {
    debateRounds: 2,
    mode: "debate",
    model: "gpt-5",
    participants: ["paper-summary", "critic"],
    synthesizer: "critic",
    title: "Review panel",
};

const skillItem = (skill: SkillMarkdownData): BundleItem => {
    return { kind: "skill", skill };
};

const bundleOf = (items: BundleItem[]): Bundle => {
    return { description: "For the team", items, name: "Team starter" };
};

const parseOk = (markdown: string) => {
    const parsed = parseBundleMarkdown(markdown);

    if (!parsed.ok) {
        throw new Error(`expected a bundle, got: ${parsed.errors.join("; ")}`);
    }

    return parsed.bundle;
};

const items = (markdown: string): (BundleItem | undefined)[] => parseOk(markdown).entries.map((entry) => entry.item);

describe("bundle format round trip", () => {
    it("reproduces skills, triggers and group chats", () => {
        const critic = { ...SKILL, name: "Critic", slug: "critic" };
        const markdown = buildBundleMarkdown(
            bundleOf([
                skillItem(SKILL),
                skillItem(critic),
                { kind: "trigger", trigger: SCHEDULE },
                { kind: "trigger", trigger: WEBHOOK },
                { group: GROUP, kind: "group" },
            ]),
        );
        const bundle = parseOk(markdown);

        expect(bundle.name).toBe("Team starter");
        expect(bundle.description).toBe("For the team");
        expect(bundle.entries.every((entry) => entry.problems.length === 0)).toBe(true);
        expect(bundle.entries.map((entry) => entry.item?.kind)).toStrictEqual(["skill", "skill", "trigger", "trigger", "group"]);

        const [first, , schedule, webhook, group] = bundle.entries.map((entry) => entry.item);

        expect(first).toMatchObject({
            kind: "skill",
            skill: { config: SKILL.config, instructions: SKILL.instructions, name: "Paper Summary", slug: "paper-summary", tags: ["papers"] },
        });
        expect(schedule).toStrictEqual({ kind: "trigger", trigger: SCHEDULE });
        expect(webhook).toStrictEqual({ kind: "trigger", trigger: WEBHOOK });
        expect(group).toStrictEqual({ group: GROUP, kind: "group" });
    });

    it("quotes a name and description that would otherwise break the frontmatter", () => {
        const markdown = buildBundleMarkdown({ description: "a: b # c", items: [], name: 'Team: "starter"' });
        const bundle = parseOk(markdown);

        expect(bundle.name).toBe('Team: "starter"');
        expect(bundle.description).toBe("a: b # c");
    });

    it("reads a file saved with Windows line endings", () => {
        const markdown = buildBundleMarkdown(bundleOf([skillItem(SKILL), { kind: "trigger", trigger: SCHEDULE }])).replaceAll("\n", "\r\n");

        expect(items(markdown).map((item) => item?.kind)).toStrictEqual(["skill", "trigger"]);
    });
});

describe("variables", () => {
    it("reads a variable's name, description and required flag, never a default a hand-edited file carries", () => {
        const markdown = buildBundleMarkdown(
            bundleOf([skillItem({ ...SKILL, variables: [{ defaultValue: "planted default", description: "d", name: "TOKEN", required: true }] })]),
        );
        const [item] = items(markdown);

        expect(markdown).toContain("planted default");
        expect(item?.kind === "skill" && item.skill.variables).toStrictEqual([{ description: "d", name: "TOKEN", required: true }]);
    });
});

describe("hand-edited fields", () => {
    it("keeps an emoji icon and drops one that is a URL or path", () => {
        const read = (icon: string) => items(buildBundleMarkdown(bundleOf([skillItem({ ...SKILL, icon })])))[0];

        expect(read("📄")).toMatchObject({ skill: { icon: "📄" } });
        expect(read("https://example.com/i.png")).not.toHaveProperty("skill.icon");
        expect(read("../x.png")).not.toHaveProperty("skill.icon");
    });

    it("blocks a webhook filter longer than the trigger create accepts, whatever its operator", () => {
        const markdown = buildBundleMarkdown(
            bundleOf([{ kind: "trigger", trigger: { ...WEBHOOK, filters: [{ op: "exists", path: "action", value: "v".repeat(501) }] } }]),
        );
        const [entry] = parseOk(markdown).entries;

        expect(entry?.problems.join(" ")).toMatch(/longer than/);
    });
});

describe("embedded SKILL.md content", () => {
    const hostile: SkillMarkdownData = {
        ...SKILL,
        instructions: [
            "Intro",
            "",
            "## skill: injected",
            "",
            "```json",
            '{"name":"x"}',
            "```",
            "",
            "## trigger: injected-too",
            "",
            "``````",
            "---",
            "name: nope",
            "---",
        ].join("\n"),
    };

    it("does not read a heading or a fence inside a skill as a new item", () => {
        const markdown = buildBundleMarkdown(bundleOf([skillItem(hostile), { kind: "trigger", trigger: SCHEDULE }]));
        const parsed = items(markdown);

        expect(parsed).toHaveLength(2);
        expect(parsed[0]).toMatchObject({ kind: "skill", skill: { slug: "paper-summary" } });
        expect(parsed[0]?.kind === "skill" && parsed[0].skill.instructions).toBe(hostile.instructions);
        expect(parsed[1]?.kind).toBe("trigger");
    });

    it("fences each item with more backticks than the longest run in its content", () => {
        const markdown = buildBundleMarkdown(bundleOf([skillItem(hostile)]));
        const opening = markdown.split("\n").find((line) => OPENING_FENCE_RE.test(line));

        expect(opening).toBeDefined();
        expect(opening!.length - "markdown".length).toBeGreaterThan(6);
    });

    it("uses a three-backtick fence for content without backticks", () => {
        const markdown = buildBundleMarkdown(bundleOf([{ kind: "trigger", trigger: SCHEDULE }]));

        expect(markdown).toContain("\n```json\n");
    });

    it("keeps a heading line inside a trigger's text in that trigger", () => {
        const trigger: BundleTrigger = { ...SCHEDULE, inputTemplate: "x\n## skill: sneaky\n```\n```\n" };
        const parsed = items(buildBundleMarkdown(bundleOf([{ kind: "trigger", trigger }])));

        expect(parsed).toStrictEqual([{ kind: "trigger", trigger }]);
    });
});

describe("refusals", () => {
    it("rejects an unknown version", () => {
        const parsed = parseBundleMarkdown("---\nbundle: 2\nname: x\n---\n");

        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.errors.join(" ")).toMatch(RE_1);
    });

    it("rejects a file that is not a bundle", () => {
        expect(parseBundleMarkdown("---\nname: a-skill\ndescription: d\n---\nbody").ok).toBe(false);
        expect(parseBundleMarkdown("just text").ok).toBe(false);
    });

    it("rejects a file over the size cap", () => {
        const parsed = parseBundleMarkdown(`---\nbundle: 1\nname: x\n---\n${"a".repeat(BUNDLE_LIMITS.bytes)}`);

        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.errors.join(" ")).toMatch(RE_2);
    });

    it.each([
        ["skills", BUNDLE_LIMITS.skills + 1],
        ["triggers", BUNDLE_LIMITS.triggers + 1],
    ])("rejects more than the allowed number of %s", (kind, count) => {
        const generated: BundleItem[] = Array.from({ length: count }, (_, index) =>
            kind === "skills"
                ? skillItem({ ...SKILL, slug: `skill-${String(index)}` })
                : { kind: "trigger", trigger: { ...SCHEDULE, name: `t${String(index)}` } },
        );
        const parsed = parseBundleMarkdown(buildBundleMarkdown(bundleOf(generated)));

        expect(parsed.ok).toBe(false);
        expect(!parsed.ok && parsed.errors.join(" ")).toMatch(RE_3);
    });

    it("rejects more group chats than allowed", () => {
        const generated: BundleItem[] = Array.from({ length: BUNDLE_LIMITS.groupChats + 1 }, (_, index) => {
            return { group: { ...GROUP, title: `g${String(index)}` }, kind: "group" };
        });

        expect(parseBundleMarkdown(buildBundleMarkdown(bundleOf(generated))).ok).toBe(false);
    });

    it("keeps an item over the per-item cap as a problem on that entry", () => {
        const big: BundleTrigger = { ...SCHEDULE, inputTemplate: "a".repeat(BUNDLE_LIMITS.itemBytes + 1) };
        const [entry] = parseOk(buildBundleMarkdown(bundleOf([{ kind: "trigger", trigger: big }]))).entries;

        expect(entry?.item).toBeUndefined();
        expect(entry?.problems.join(" ")).toMatch(RE_2);
    });

    it("rejects an unterminated fence", () => {
        const markdown = "---\nbundle: 1\nname: x\n---\n\n## trigger: t\n\n```json\n{";

        expect(parseBundleMarkdown(markdown).ok).toBe(false);
    });

    it("rejects text between an item's heading and its fence, and after it", () => {
        const before = "---\nbundle: 1\nname: x\n---\n\n## trigger: t\n\nsurprise\n\n```json\n{}\n```\n";
        const after = "---\nbundle: 1\nname: x\n---\n\n## trigger: t\n\n```json\n{}\n```\n\nsurprise\n";

        expect(parseBundleMarkdown(before).ok).toBe(false);
        expect(parseBundleMarkdown(after).ok).toBe(false);
    });

    it("rejects an unknown item kind", () => {
        expect(parseBundleMarkdown("---\nbundle: 1\nname: x\n---\n\n## agent: t\n\n```json\n{}\n```\n").ok).toBe(false);
    });

    it("refuses event triggers as a problem on that entry", () => {
        const markdown = buildBundleMarkdown(bundleOf([{ kind: "trigger", trigger: SCHEDULE }])).replace('"type": "schedule"', '"type": "event"');
        const [entry] = parseOk(markdown).entries;

        expect(entry?.item).toBeUndefined();
        expect(entry?.problems.join(" ")).toMatch(RE_4);
    });

    it("flags a second skill with a slug already used in the bundle", () => {
        const { entries } = parseOk(buildBundleMarkdown(bundleOf([skillItem(SKILL), skillItem({ ...SKILL, name: "Other" })])));

        expect(entries[0]?.problems).toStrictEqual([]);
        expect(entries[1]?.item).toBeUndefined();
        expect(entries[1]?.problems.join(" ")).toMatch(RE_5);
    });

    it("keeps an unreadable skill as a problem on its own entry", () => {
        const markdown = buildBundleMarkdown(bundleOf([skillItem(SKILL), { kind: "trigger", trigger: SCHEDULE }])).replace("name: paper-summary\n", "");
        const { entries } = parseOk(markdown);

        expect(entries[0]?.item).toBeUndefined();
        expect(entries[0]?.problems.length).toBeGreaterThan(0);
        expect(entries[1]?.item?.kind).toBe("trigger");
    });
});

describe("only whitelisted fields are read", () => {
    it("ignores enabled, secrets, bot and organization fields written into an item", () => {
        const markdown = buildBundleMarkdown(bundleOf([{ kind: "trigger", trigger: WEBHOOK }])).replace(
            '"type": "webhook"',
            '"type": "webhook", "enabled": true, "webhookSecret": "s3cret", "botId": "bot1", "organizationId": "org1", "userId": "u1"',
        );
        const [entry] = parseOk(markdown).entries;

        expect(entry?.item).toStrictEqual({ kind: "trigger", trigger: WEBHOOK });
    });

    it("flags a trigger whose fields have the wrong type", () => {
        const markdown = buildBundleMarkdown(bundleOf([{ kind: "trigger", trigger: SCHEDULE }])).replace('"name": "Weekly digest"', '"name": 5');
        const [entry] = parseOk(markdown).entries;

        expect(entry?.item).toBeUndefined();
        expect(entry?.problems.length).toBeGreaterThan(0);
    });
});

describe("export builders", () => {
    const SECRETS = {
        apiKey: "sk-live-1234567890",
        basicAuthUrl: "https://user:hunter2@example.com/icon.png",
        botId: "bot_secret_9",
        connectorTool: "connector:github:create_issue",
        defaultValue: "default-token-xyz",
        encryptedWebhook: "enc:v1:AAAA-ciphertext",
        mcpTool: "mcp__corp__deploy",
        orgId: "org_secret_42",
        privateRepo: "https://github.com/acme/private-repo",
        userId: "user_secret_77",
        voice: "Secret Voice",
    };
    const KNOWN = new Set(["knowledgeSearch", "webSearch"]);
    const isKnownTool = (name: string): boolean => KNOWN.has(name);

    const skillRow = {
        _id: "skill1",
        category: "research",
        config: {
            additionalTools: ["webSearch", SECRETS.connectorTool, SECRETS.mcpTool],
            apiKey: SECRETS.apiKey,
            disabledTools: ["knowledgeSearch", SECRETS.connectorTool],
            preferredModel: "gpt-5",
            reasoningEffort: 1,
            voice: SECRETS.voice,
        },
        description: "d",
        icon: SECRETS.basicAuthUrl,
        instructions: "Do the thing",
        name: "N",
        organizationId: SECRETS.orgId,
        slug: "n",
        source: { repoUrl: SECRETS.privateRepo, type: "github" },
        tags: ["a"],
        userId: SECRETS.userId,
        variables: [{ defaultValue: SECRETS.defaultValue, description: "v", name: "TOKEN", required: true }],
        version: "1",
    };

    const triggerRow = {
        botComputer: true,
        botId: SECRETS.botId,
        cronExpression: "0 9 * * *",
        description: "d",
        enabled: true,
        inputTemplate: "go",
        model: "gpt-5",
        name: "T",
        organizationId: SECRETS.orgId,
        quietWhenEmpty: true,
        type: "schedule" as const,
        userId: SECRETS.userId,
        webhookSecret: SECRETS.encryptedWebhook,
    };

    it("never writes a secret field name or value, wherever the source carries one", () => {
        const webhook = triggerItemOf({
            ...triggerRow,
            cronExpression: undefined,
            filters: [{ op: "exists", path: "a" }],
            type: "webhook",
            webhookSignatureScheme: "timestamped",
        });
        const group = groupItemOf(
            {
                groupChat: { mode: "round-robin", participants: [{ skillId: "a" }, { skillId: "b" }], stopRequestedAt: 5 },
                model: "gpt-5",
                organizationId: SECRETS.orgId,
                title: "G",
                userId: SECRETS.userId,
            } as Parameters<typeof groupItemOf>[0],
            (id) => id,
        );
        const results = [triggerItemOf(triggerRow), webhook, group];

        expect(results.every((result) => result.ok)).toBe(true);

        const markdown = buildBundleMarkdown({
            description: "d",
            items: [skillItemOf(skillRow, { isKnownTool }), ...results.flatMap((result) => (result.ok ? [result.item] : []))],
            name: "n",
        });

        for (const value of Object.values(SECRETS)) {
            expect(markdown, value).not.toContain(value);
        }

        for (const field of [
            "webhookSecret",
            "apiKey",
            "botId",
            "botComputer",
            "quietWhenEmpty",
            "organizationId",
            "userId",
            "encryptedKey",
            "headers",
            "authorization",
            "stopRequestedAt",
            "enabled",
            "voice",
            "repoUrl",
            "defaultValue",
        ]) {
            expect(markdown, field).not.toContain(field);
        }
    });

    it("keeps the safe parts of a skill", () => {
        const item = skillItemOf(skillRow, { isKnownTool });

        expect(item).toMatchObject({
            kind: "skill",
            skill: {
                category: "research",
                config: { additionalTools: ["webSearch"], disabledTools: ["knowledgeSearch"], preferredModel: "gpt-5", reasoningEffort: 1 },
                slug: "n",
            },
        });
        expect(item.skill.variables).toStrictEqual([{ description: "v", name: "TOKEN", required: true }]);
        expect(item.skill.icon).toBeUndefined();
    });

    it("keeps an emoji icon", () => {
        expect(skillItemOf({ ...skillRow, icon: "📄" }, { isKnownTool }).skill.icon).toBe("📄");
    });

    it("drops a custom-endpoint model from a skill and refuses it on a trigger or group chat", () => {
        expect(skillItemOf({ ...skillRow, config: { preferredModel: "custom:abc/model" } }, { isKnownTool }).skill.config).toBeUndefined();
        expect(triggerItemOf({ ...triggerRow, model: "custom:abc/model" })).toMatchObject({ ok: false });
        expect(
            groupItemOf(
                { groupChat: { mode: "round-robin", participants: [{ skillId: "a" }, { skillId: "b" }] }, model: "custom:abc/model", title: "G" },
                (id) => id,
            ),
        ).toMatchObject({ ok: false });
    });

    it("refuses event triggers", () => {
        expect(triggerItemOf({ ...triggerRow, type: "event" })).toMatchObject({ ok: false });
    });

    it("lets a webhook trigger carry neither secret nor URL", () => {
        const result = triggerItemOf({ ...triggerRow, cronExpression: undefined, type: "webhook" });

        expect(result).toMatchObject({ ok: true });
        expect(JSON.stringify(result)).not.toMatch(RE_6);
    });

    it("names group participants by slug and refuses one it cannot name", () => {
        const resolve = (id: string): string | undefined => (id === "gone" ? undefined : `slug-${id}`);
        const ok = groupItemOf(
            { groupChat: { mode: "parallel", participants: [{ skillId: "a" }, { skillId: "b" }], synthesizerSkillId: "b" }, model: "gpt-5", title: "G" },
            resolve,
        );
        const missing = groupItemOf(
            { groupChat: { mode: "parallel", participants: [{ skillId: "a" }, { skillId: "gone" }] }, model: "gpt-5", title: "G" },
            resolve,
        );

        expect(ok).toMatchObject({ item: { group: { participants: ["slug-a", "slug-b"], synthesizer: "slug-b" }, kind: "group" }, ok: true });
        expect(missing).toMatchObject({ ok: false });
    });
});
