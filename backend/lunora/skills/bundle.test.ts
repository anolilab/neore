/**
 * The team bundle through the real procedures: export reads only the caller's
 * own rows and never a secret, an import goes through `createSkill`,
 * `createGroupChat` and `createTrigger` themselves (so a trigger comes out
 * disabled), and a refused item leaves nothing behind.
 */
import { MODEL_LOOKUP } from "@neore/ai/models";
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { registeredApi } from "../../test/registered-api";
import { schemaWithShardedTables } from "../lib/test-schema";
import type { Bundle, BundleItem } from "./bundle-format";
import { buildBundleMarkdown } from "./bundle-format";
import { isSelectableTextModel } from "./builder-logic";

const RE_1 = /alpha-2/;
const RE_2 = /Panel.*could not be imported.*Nothing was imported/;
const RE_3 = /Too often/;
const RE_4 = /beta.*not selected/;
const RE_5 = /version/i;
const RE_6 = /KB/;
const RE_7 = /not found/i;
const RE_8 = /schedules and webhooks/;
const RE_9 = /custom endpoint/;

const byText = (a: string, b: string): number => a.localeCompare(b);

const registry = vi.hoisted(() => new Map<string, unknown>());
const limits = vi.hoisted(() => {
    return { failFamily: undefined as string | undefined };
});

vi.mock("../_generated/api", async (importOriginal) => registeredApi(await importOriginal(), registry));
vi.mock("../_generated/internal", async (importOriginal) => registeredApi(await importOriginal(), registry));

const sessionFrom = vi.hoisted(() => async (context: { auth: { userId?: string | null } }) => {
    const { userId } = context.auth;

    return userId ? { activeOrganization: null, email: `${userId}@example.com`, id: userId, isAdmin: false, name: userId, plan: "premium", userId } : null;
});

vi.mock("../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
        getSessionUserWithAnonymous: sessionFrom,
    };
});

vi.mock("../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/rate-limiter")>()),
        rateLimitGuard: async (context: { rateLimitKey: string }) => {
            if (context.rateLimitKey === limits.failFamily) {
                throw new Error(`Rate limit exceeded for ${context.rateLimitKey}`);
            }
        },
    };
});

// The route table is `.global()` (D1), which the harness cannot store; routing is not under test.
vi.mock("../lib/shard-routes", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../lib/shard-routes")>()),
        deleteShardRoute: async () => undefined,
        setShardRoute: async () => undefined,
    };
});

const MODULES = {
    bots_functions: async () => await import("../bots/functions"),
    chat_custom_providers: async () => await import("../chat/custom-providers"),
    chat_group_functions: async () => await import("../chat/group/functions"),
    skills_bundle: async () => await import("./bundle"),
    skills_functions: async () => await import("./functions"),
    triggers_functions: async () => await import("../triggers/functions"),
} as const;

beforeAll(async () => {
    for (const [module, load] of Object.entries(MODULES)) {
        const exports = await load();

        for (const [name, value] of Object.entries(exports)) {
            registry.set(`${module}:${name}`, value);
        }
    }
}, 60_000);

const procedureAt = (module: keyof typeof MODULES, name: string): never => {
    const procedure = registry.get(`${module}:${name}`);

    if (!procedure) {
        throw new Error(`bundle.test: ${module}.${name} is not exported`);
    }

    return procedure as never;
};

const firstTextModel = (): string => {
    for (const definition of MODEL_LOOKUP.values()) {
        if (isSelectableTextModel(definition)) {
            return definition.id;
        }
    }

    throw new Error("bundle.test: the registry has no selectable text model");
};

const MODEL = firstTextModel();
const OWNER = "user-owner";
const OTHER = "user-other";
const SECRET_CIPHERTEXT = "v1:encrypted-webhook-secret";

let harness: ReturnType<typeof lunoraTest>;

const as = (userId: string) => harness.withIdentity({ userId } as never);
const run = async <T>(body: (context: any) => Promise<T>): Promise<T> => await harness.run(body);

beforeEach(() => {
    limits.failFamily = undefined;
    harness = lunoraTest(schemaWithShardedTables(["skills", "skillStats", "skillFiles"]) as never);
});

afterEach(() => {
    harness.close();
});

const createSkill = async (userId: string, slug: string, extra: Record<string, unknown> = {}): Promise<string> =>
    (await as(userId).mutation(procedureAt("skills_functions", "createSkill"), {
        description: `${slug} skill`,
        instructions: `Be ${slug}.`,
        name: slug,
        slug,
        source: { type: "editor" },
        ...extra,
    } as never)) as string;

const createTrigger = async (userId: string, extra: Record<string, unknown> = {}): Promise<{ triggerId: string; webhookSecret?: string }> =>
    (await as(userId).mutation(procedureAt("triggers_functions", "createTrigger"), {
        cronExpression: "0 9 * * 1",
        inputTemplate: "Summarise the week",
        model: MODEL,
        name: "Weekly",
        type: "schedule",
        ...extra,
    } as never)) as { triggerId: string; webhookSecret?: string };

const createGroup = async (userId: string, skillIds: string[]): Promise<string> =>
    (
        (await as(userId).mutation(procedureAt("chat_group_functions", "createGroupChat"), {
            mode: "round-robin",
            model: MODEL,
            skillIds,
            title: "Panel",
        } as never)) as { threadId: string }
    ).threadId;

const exportBundle = async (userId: string, args: { groupChatIds?: string[]; skillIds?: string[]; triggerIds?: string[] }) =>
    (await as(userId).action(procedureAt("skills_bundle", "exportBundle"), {
        groupChatIds: [],
        name: "Team",
        skillIds: [],
        triggerIds: [],
        ...args,
    } as never)) as {
        filename: string;
        markdown: string;
    };

const importBundle = async (userId: string, markdown: string, selected: string[]) =>
    (await as(userId).action(procedureAt("skills_bundle", "importBundle"), { markdown, selected } as never)) as {
        items: { id: string; key: string; kind: string; title: string; webhookSecret?: string }[];
        warnings: string[];
    };

const rows = async (table: string): Promise<any[]> => await run(async (context) => await context.db.query(table).collect());

const skill = (slug: string): BundleItem => {
    return { kind: "skill", skill: { description: `${slug} skill`, instructions: `Be ${slug}.`, name: slug, slug } };
};

const bundleOf = (items: BundleItem[]): string => buildBundleMarkdown({ description: "", items, name: "Incoming" } satisfies Bundle);

const FULL: BundleItem[] = [
    skill("alpha"),
    skill("beta"),
    { kind: "trigger", trigger: { cronExpression: "0 9 * * 1", inputTemplate: "Go", model: MODEL, name: "Weekly", type: "schedule" } },
    { kind: "trigger", trigger: { filters: [{ op: "exists", path: "action" }], model: MODEL, name: "On PR", type: "webhook" } },
    { group: { mode: "round-robin", model: MODEL, participants: ["alpha", "beta"], title: "Panel" }, kind: "group" },
];
const ALL = ["skill:0", "skill:1", "trigger:2", "trigger:3", "group:4"];

describe("importBundle", () => {
    it("creates every picked item through the real creates, triggers disabled and a group chat idle", async () => {
        // A file edited by hand to turn things on and to carry a secret: neither is read.
        const markdown = bundleOf(FULL)
            .replaceAll('"type": "webhook"', '"type": "webhook", "enabled": true, "webhookSecret": "planted"')
            .replaceAll('"type": "schedule"', '"type": "schedule", "enabled": true');
        const result = await importBundle(OWNER, markdown, ALL);

        expect(result.items.map((item) => item.kind)).toStrictEqual(["skill", "skill", "group", "trigger", "trigger"]);

        const triggers = await rows("triggers");

        expect(triggers).toHaveLength(2);
        expect(triggers.every((trigger) => trigger.enabled === false)).toBe(true);
        expect(triggers.every((trigger) => trigger.userId === OWNER && trigger.botId === undefined)).toBe(true);

        const skills = await rows("skills");

        expect(skills.map((row) => row.slug).toSorted(byText)).toStrictEqual(["alpha", "beta"]);
        expect(skills.every((row) => row.visibility === "private" && row.userId === OWNER)).toBe(true);

        const [thread] = await rows("threads");

        expect(thread.groupChat.participants.map((participant: { skillId: string }) => participant.skillId).toSorted(byText)).toStrictEqual(
            skills.map((row) => row._id).toSorted(byText),
        );
        expect(await rows("messages")).toHaveLength(0);
    });

    it("returns a new webhook's secret once, and stores only its encrypted form", async () => {
        const result = await importBundle(OWNER, bundleOf(FULL), ALL);
        const secrets = result.items.flatMap((item) => (item.webhookSecret ? [item.webhookSecret] : []));
        const triggers = await rows("triggers");
        const stored = triggers.find((trigger) => trigger.type === "webhook");

        expect(secrets).toHaveLength(1);
        expect(result.items.find((item) => item.title === "Weekly")?.webhookSecret).toBeUndefined();
        expect(stored.webhookSecret).toBeTruthy();
        expect(stored.webhookSecret).not.toContain(secrets[0]);
        expect(JSON.stringify(result.warnings)).not.toContain(secrets[0]!);
    });

    it("gives a name that is taken a free slug", async () => {
        await createSkill(OWNER, "alpha");

        const result = await importBundle(OWNER, bundleOf([skill("alpha")]), ["skill:0"]);

        expect(result.items).toHaveLength(1);
        const skills = await rows("skills");

        expect(skills.map((row) => row.slug).toSorted(byText)).toStrictEqual(["alpha", "alpha-2"]);
        expect(result.warnings.join(" ")).toMatch(RE_1);
    });

    it("leaves nothing behind when a later item is refused", async () => {
        limits.failFamily = "chat/create";

        await expect(importBundle(OWNER, bundleOf(FULL), ALL)).rejects.toThrow(RE_2);

        expect(await rows("skills")).toHaveLength(0);
        expect(await rows("skillStats")).toHaveLength(0);
        expect(await rows("userSkills")).toHaveLength(0);
        expect(await rows("triggers")).toHaveLength(0);
        expect(await rows("threads")).toHaveLength(0);
    });

    it("refuses a pick that the dry run blocks, before creating anything", async () => {
        const markdown = bundleOf([
            skill("alpha"),
            { kind: "trigger", trigger: { cronExpression: "* * * * *", model: MODEL, name: "Too often", type: "schedule" } },
        ]);

        await expect(importBundle(OWNER, markdown, ["skill:0", "trigger:1"])).rejects.toThrow(RE_3);
        expect(await rows("skills")).toHaveLength(0);
    });

    it("refuses a group chat whose participants are not all selected", async () => {
        await expect(importBundle(OWNER, bundleOf(FULL), ["skill:0", "group:4"])).rejects.toThrow(RE_4);
        expect(await rows("skills")).toHaveLength(0);
    });

    it("refuses an unknown version and an oversized file", async () => {
        await expect(importBundle(OWNER, bundleOf(FULL).replace("bundle: 1", "bundle: 2"), ALL)).rejects.toThrow(RE_5);
        await expect(importBundle(OWNER, `---\nbundle: 1\nname: x\n---\n${"a".repeat(600 * 1024)}`, ALL)).rejects.toThrow(RE_6);
    });
});

describe("previewBundle", () => {
    it("lists every item with what it does, and creates nothing", async () => {
        const tooOften: BundleItem = { kind: "trigger", trigger: { cronExpression: "* * * * *", model: MODEL, name: "Too often", type: "schedule" } };
        const markdown = bundleOf([...FULL.slice(0, 4), tooOften]);
        const preview = (await as(OWNER).action(procedureAt("skills_bundle", "previewBundle"), { markdown } as never)) as {
            entries: { kind: string; problems: string[]; skill?: { tools: string[] }; trigger?: { schedule?: string } }[];
            name: string;
        };

        expect(preview.name).toBe("Incoming");
        expect(preview.entries.map((entry) => entry.kind)).toStrictEqual(["skill", "skill", "trigger", "trigger", "trigger"]);
        expect(preview.entries[2]?.trigger?.schedule).toBe("0 9 * * 1");
        expect(preview.entries.slice(0, 4).every((entry) => entry.problems.length === 0)).toBe(true);
        expect(preview.entries[4]?.problems.join(" ")).toContain("cron");
        expect(await rows("skills")).toHaveLength(0);
        expect(await rows("triggers")).toHaveLength(0);
    });
});

describe("exportBundle", () => {
    it("never exports another user's skill, trigger or group chat by id", async () => {
        const skillId = await createSkill(OTHER, "theirs");
        const { triggerId } = await createTrigger(OTHER);
        const other2 = await createSkill(OTHER, "theirs-2");
        const threadId = await createGroup(OTHER, [skillId, other2]);

        for (const args of [{ skillIds: [skillId] }, { triggerIds: [triggerId] }, { groupChatIds: [threadId] }]) {
            await expect(exportBundle(OWNER, args)).rejects.toThrow(RE_7);
        }

        await expect(exportBundle(OTHER, { skillIds: [skillId] })).resolves.toHaveProperty("markdown");
    });

    it("writes no secret, owner, bot or organization, however the rows were filled", async () => {
        const skillId = await createSkill(OWNER, "alpha", {
            config: { additionalTools: ["connector:github:create_issue"], voice: "Secret Voice" },
            icon: "https://user:hunter2@example.com/i.png",
            variables: [{ defaultValue: "default-token-xyz", name: "TOKEN" }],
        });
        const second = await createSkill(OWNER, "beta");
        const { triggerId: hookId } = await createTrigger(OWNER, { cronExpression: undefined, name: "Hook", type: "webhook" });
        const { triggerId: scheduleId } = await createTrigger(OWNER);
        const threadId = await createGroup(OWNER, [skillId, second]);

        await run(async (context) => {
            await context.db.patch(hookId, { organizationId: "org_secret_42", webhookSecret: SECRET_CIPHERTEXT });
            await context.db.patch(scheduleId, { botId: "bot_secret_9", organizationId: "org_secret_42" });
            await context.db.patch(threadId, { organizationId: "org_secret_42" });
        });

        const { markdown } = await exportBundle(OWNER, { groupChatIds: [threadId], skillIds: [skillId, second], triggerIds: [hookId, scheduleId] });

        for (const secret of [
            "connector:github",
            "Secret Voice",
            "hunter2",
            "default-token-xyz",
            SECRET_CIPHERTEXT,
            "org_secret_42",
            "bot_secret_9",
            OWNER,
            hookId,
            scheduleId,
            threadId,
            skillId,
        ]) {
            expect(markdown, secret).not.toContain(secret);
        }

        for (const field of ["webhookSecret", "botId", "organizationId", "userId", "voice", "defaultValue", "enabled", "source"]) {
            expect(markdown, field).not.toContain(field);
        }
    });

    it("brings a group chat's participants along, referenced by slug", async () => {
        const first = await createSkill(OWNER, "alpha");
        const second = await createSkill(OWNER, "beta");
        const threadId = await createGroup(OWNER, [first, second]);
        const { markdown } = await exportBundle(OWNER, { groupChatIds: [threadId] });

        expect(markdown).toContain("## skill: alpha");
        expect(markdown).toContain("## skill: beta");
        expect(markdown).toContain('"participants": [\n    "alpha",\n    "beta"\n  ]');
    });

    it("refuses an event trigger and a trigger on a custom endpoint", async () => {
        const event = await run(async (context) =>
            context.db.insert("triggers", {
                createdAt: 1,
                enabled: false,
                model: MODEL,
                name: "Event",
                triggerCount: 0,
                type: "event",
                updatedAt: 1,
                userId: OWNER,
            }),
        );
        const custom = await run(async (context) =>
            context.db.insert("triggers", {
                createdAt: 1,
                cronExpression: "0 9 * * 1",
                enabled: false,
                model: "custom:abc/model",
                name: "Custom",
                triggerCount: 0,
                type: "schedule",
                updatedAt: 1,
                userId: OWNER,
            }),
        );

        await expect(exportBundle(OWNER, { triggerIds: [event] })).rejects.toThrow(RE_8);
        await expect(exportBundle(OWNER, { triggerIds: [custom] })).rejects.toThrow(RE_9);
    });

    it("round-trips: what one account exports, another imports", async () => {
        const first = await createSkill(OWNER, "alpha", { config: { reasoningEffort: 2 }, tags: ["x"] });
        const second = await createSkill(OWNER, "beta");
        const { triggerId } = await createTrigger(OWNER);
        const { triggerId: hookId } = await createTrigger(OWNER, {
            cronExpression: undefined,
            filters: [{ op: "exists", path: "action" }],
            name: "Hook",
            type: "webhook",
        });
        const threadId = await createGroup(OWNER, [first, second]);
        const { markdown } = await exportBundle(OWNER, { groupChatIds: [threadId], skillIds: [first, second], triggerIds: [triggerId, hookId] });
        const result = await importBundle(OTHER, markdown, ["skill:0", "skill:1", "trigger:2", "trigger:3", "group:4"]);

        expect(result.items).toHaveLength(5);

        const allSkills = await rows("skills");
        const allTriggers = await rows("triggers");
        const allThreads = await rows("threads");
        const mine = allSkills.filter((row) => row.userId === OTHER);
        const theirTriggers = allTriggers.filter((row) => row.userId === OTHER);
        const thread = allThreads.find((row) => row.userId === OTHER);

        expect(mine.map((row) => row.slug).toSorted(byText)).toStrictEqual(["alpha", "beta"]);
        expect(mine.find((row) => row.slug === "alpha")).toMatchObject({ config: { reasoningEffort: 2 }, tags: ["x"] });
        expect(theirTriggers.map((row) => row.name).toSorted(byText)).toStrictEqual(["Hook", "Weekly"]);
        expect(theirTriggers.every((row) => row.enabled === false)).toBe(true);
        expect(theirTriggers.find((row) => row.name === "Hook")?.filters).toStrictEqual([{ op: "exists", path: "action" }]);
        expect(thread.groupChat.participants.map((participant: { skillId: string }) => participant.skillId).toSorted(byText)).toStrictEqual(
            mine.map((row) => row._id).toSorted(byText),
        );
    });
});

describe("listBundleCandidates", () => {
    it("lists only the caller's own items", async () => {
        const mine = await createSkill(OWNER, "alpha");
        const second = await createSkill(OWNER, "beta");

        await createSkill(OTHER, "theirs");
        await createTrigger(OTHER);
        await createTrigger(OWNER);
        await createGroup(OWNER, [mine, second]);

        const candidates = (await as(OWNER).query(procedureAt("skills_bundle", "listBundleCandidates"), {} as never)) as {
            groupChats: unknown[];
            skills: { slug: string }[];
            triggers: unknown[];
        };

        expect(candidates.skills.map((row) => row.slug).toSorted(byText)).toStrictEqual(["alpha", "beta"]);
        expect(candidates.triggers).toHaveLength(1);
        expect(candidates.groupChats).toHaveLength(1);
    });
});
