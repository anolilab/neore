import { describe, expect, it, vi } from "vitest";

import { GROUP_CHAT_MODES } from "../chat/group/logic";
import { getRateLimitKey, RATE_LIMIT_CONFIGS } from "../lib/rate-limiter";
import type { Bundle, BundleGroup, BundleItem, BundleTrigger } from "./bundle-format";
import { BUNDLE_GROUP_MODES, BUNDLE_LIMITS, buildBundleMarkdown, parseBundleMarkdown } from "./bundle-format";
import type { BundleOps, PlanEnv, PlanEntry } from "./bundle-plan";
import { assertSelectionImportable, BundleImportError, mayRetryImport, planBundle, runBundleImport } from "./bundle-plan";
import type { SkillMarkdownData } from "./markdown";

const RE_1 = /imported as "alpha-2"/;
const RE_2 = /cron/;
const RE_3 = /time zone/;
const RE_4 = /not available/;
const RE_5 = /beta.*not selected/;
const RE_6 = /"beta" is not a skill in this bundle/;
const RE_7 = /at least two/;
const RE_8 = /cannot be imported/;
const RE_9 = /synthesizer/;
const RE_10 = /"Panel" could not be imported \(Rate limit exceeded\). Nothing was imported./;
const RE_11 = /could not be removed again: alpha/;
const RE_12 = /Weekly/;
const RE_13 = /not in this bundle/;
const RE_14 = /at least one/;
const RE_16 = /by hand/;
const RE_KEPT = /Kept with the skills it uses.*Panel/;
const RE_17 = /never fires|no next run/i;

const byText = (a: string, b: string): number => a.localeCompare(b);

const skill = (slug: string, config?: SkillMarkdownData["config"]): BundleItem => {
    return { kind: "skill", skill: { config, description: `${slug} does things`, instructions: `Be ${slug}.`, name: slug, slug } };
};

const SCHEDULE: BundleTrigger = {
    cronExpression: "0 9 * * 1",
    inputTemplate: "Summarise",
    model: "good-model",
    name: "Weekly",
    timezone: "Europe/Berlin",
    type: "schedule",
};
const WEBHOOK: BundleTrigger = { filters: [{ op: "equals", path: "action", value: "opened" }], model: "good-model", name: "On PR", type: "webhook" };
const GROUP: BundleGroup = { mode: "round-robin", model: "good-model", participants: ["alpha", "beta"], title: "Panel" };

const ENV: PlanEnv = {
    existingSkillCount: 0,
    existingSlugs: new Set(),
    isKnownTool: (name) => name === "webSearch",
    isModelRunnable: (model) => model === "good-model",
    now: Date.UTC(2026, 9, 1),
    skillLimit: undefined,
};

const plan = (items: BundleItem[], selected?: string[], env: Partial<PlanEnv> = {}): PlanEntry[] => {
    const bundle: Bundle = { description: "", items, name: "b" };
    const parsed = parseBundleMarkdown(buildBundleMarkdown(bundle));

    if (!parsed.ok) {
        throw new Error(parsed.errors.join("; "));
    }

    return planBundle(parsed.bundle, selected ? new Set(selected) : undefined, { ...ENV, ...env });
};

const entryOf = (entries: PlanEntry[], key: string): PlanEntry => entries.find((entry) => entry.key === key)!;

describe("limits", () => {
    it("keeps each kind's cap below the smallest window of the create procedure it goes through", () => {
        const rate = (family: string): number => RATE_LIMIT_CONFIGS[getRateLimitKey(family as never, "free")]!.rate;

        expect(BUNDLE_LIMITS.skills).toBeLessThan(rate("skills/create"));
        expect(BUNDLE_LIMITS.triggers).toBeLessThan(rate("triggers/create"));
        expect(BUNDLE_LIMITS.groupChats).toBeLessThan(rate("chat/create"));
    });

    it("names the group chat modes the app has", () => {
        expect([...BUNDLE_GROUP_MODES].toSorted(byText)).toStrictEqual([...GROUP_CHAT_MODES].toSorted(byText));
    });
});

describe("the dry run", () => {
    it("gives a skill a free slug, counting the ones earlier in the same bundle", () => {
        const entries = plan([skill("alpha"), skill("alpha-2")], undefined, { existingSlugs: new Set(["alpha"]) });

        expect(entryOf(entries, "skill:0").view.skill?.slug).toBe("alpha-2");
        expect(entryOf(entries, "skill:1").view.skill?.slug).toBe("alpha-2-2");
        expect(entryOf(entries, "skill:0").warnings.join(" ")).toMatch(RE_1);
    });

    it("lists the tools a skill adds and the ones it drops", () => {
        const [entry] = plan([skill("alpha", { additionalTools: ["webSearch", "shellRun"], disabledTools: ["webSearch"] })]);

        expect(entry?.view.skill).toMatchObject({ disabledTools: ["webSearch"], droppedTools: ["shellRun"], tools: ["webSearch"] });
        expect(entry?.problems).toStrictEqual([]);
        expect(entry?.plan?.kind).toBe("skill");
    });

    it("shows every setting a skill would run with, not only its tools", () => {
        const [entry] = plan([skill("alpha", { reasoningEffort: 4, searchMode: "web" })]);

        expect(entry?.view.skill).toMatchObject({ reasoningEffort: 4, searchMode: "web" });
    });

    it("shows and creates a group chat with the options it will be stored with", () => {
        const debate: BundleItem = { group: { ...GROUP, debateRounds: 99, mode: "debate", synthesizer: "alpha" }, kind: "group" };
        const roundRobin: BundleItem = { group: { ...GROUP, debateRounds: 7, synthesizer: "alpha", title: "Plain" }, kind: "group" };
        const entries = plan([skill("alpha"), skill("beta"), debate, roundRobin], ["skill:0", "skill:1", "group:2", "group:3"]);
        const clamped = entryOf(entries, "group:2");

        expect(clamped.view.group?.debateRounds).toBe(3);
        expect(clamped.view.group?.synthesizer).toBe("alpha");
        expect(clamped.plan).toMatchObject({ create: { debateRounds: 3 }, kind: "group" });

        const plain = entryOf(entries, "group:3");

        expect(plain.view.group).not.toHaveProperty("debateRounds");
        expect(plain.view.group).not.toHaveProperty("synthesizer");
        expect(plain.plan?.kind === "group" && plain.plan.create).not.toHaveProperty("debateRounds");
    });

    it("holds a free account to its limit only for the skills actually picked", () => {
        const items = [skill("a"), skill("b"), skill("c")];
        const limited = { existingSkillCount: 3, skillLimit: 5 };
        const review = plan(items, undefined, limited);

        expect(review.every((entry) => entry.problems.length === 0)).toBe(true);

        const all = plan(items, ["skill:0", "skill:1", "skill:2"], limited);

        expect(all.map((entry) => entry.problems.length > 0)).toStrictEqual([false, false, true]);

        const picked = plan(items, ["skill:0", "skill:2"], limited);

        expect(picked.map((entry) => entry.problems.length > 0)).toStrictEqual([false, false, false]);
    });

    it("describes a schedule and checks its cron, time zone and model", () => {
        const [ok, cron, zone, model] = plan([
            { kind: "trigger", trigger: SCHEDULE },
            { kind: "trigger", trigger: { ...SCHEDULE, cronExpression: "* * * * *" } },
            { kind: "trigger", trigger: { ...SCHEDULE, timezone: "Mars/Olympus" } },
            { kind: "trigger", trigger: { ...SCHEDULE, model: "gone" } },
        ]);

        expect(ok?.problems).toStrictEqual([]);
        expect(ok?.view.trigger).toMatchObject({ schedule: "0 9 * * 1", task: "Summarise", timezone: "Europe/Berlin", type: "schedule" });
        expect(ok?.view.trigger?.nextRunAt).toBeGreaterThan(ENV.now);
        expect(cron?.problems.join(" ")).toMatch(RE_2);
        expect(zone?.problems.join(" ")).toMatch(RE_3);
        expect(model?.problems.join(" ")).toMatch(RE_4);
        expect([cron, zone, model].every((entry) => entry?.plan === undefined)).toBe(true);
    });

    it("carries the full text the user is asked to approve: a skill's instructions and a trigger's prompts, untruncated", () => {
        const instructions = `Always ${"obey the file. ".repeat(400)}END-OF-INSTRUCTIONS`;
        const systemPrompt = `${"system ".repeat(300)}END-OF-SYSTEM`;
        const inputTemplate = `${"task ".repeat(300)}END-OF-TASK`;
        const [skillEntry, triggerEntry] = plan([
            { kind: "skill", skill: { description: "d", instructions, name: "alpha", slug: "alpha" } },
            { kind: "trigger", trigger: { ...SCHEDULE, inputTemplate, systemPrompt } },
        ]);

        expect(skillEntry?.view.skill?.instructions).toBe(instructions);
        expect(triggerEntry?.view.trigger?.systemPrompt).toBe(systemPrompt);
        expect(triggerEntry?.view.trigger?.task).toBe(inputTemplate);
    });

    it("blocks what the create procedures would refuse, so the preview never says ready for it", () => {
        const [trigger, category, tag, variable, ok] = plan([
            { kind: "trigger", trigger: { ...SCHEDULE, description: "x".repeat(10_001) } },
            { kind: "skill", skill: { category: "c".repeat(501), description: "d", instructions: "i", name: "a", slug: "a" } },
            { kind: "skill", skill: { description: "d", instructions: "i", name: "b", slug: "b", tags: ["t".repeat(501)] } },
            {
                kind: "skill",
                skill: { description: "d", instructions: "i", name: "c", slug: "c", variables: [{ description: "v".repeat(10_001), name: "V" }] },
            },
            { kind: "trigger", trigger: { ...SCHEDULE, description: "x".repeat(10_000) } },
        ]);

        for (const entry of [trigger, category, tag, variable]) {
            expect(entry?.problems.length, entry?.title).toBeGreaterThan(0);
            expect(entry?.plan).toBeUndefined();
        }

        expect(ok?.problems).toStrictEqual([]);
    });

    it("blocks a schedule that never fires, instead of reporting it ready", () => {
        const [entry] = plan([{ kind: "trigger", trigger: { ...SCHEDULE, cronExpression: "0 0 31 2 *" } }]);

        expect(entry?.problems.join(" ")).toMatch(RE_17);
        expect(entry?.plan).toBeUndefined();
    });

    it("describes a webhook by its filters and blocks an invalid one", () => {
        const [ok, bad] = plan([
            { kind: "trigger", trigger: WEBHOOK },
            { kind: "trigger", trigger: { ...WEBHOOK, filters: [{ op: "equals", path: "" }] } },
        ]);

        expect(ok?.view.trigger?.filters).toStrictEqual(['action equals "opened"']);
        expect(bad?.problems.length).toBeGreaterThan(0);
    });

    it("keeps trigger creation args free of anything but the whitelist", () => {
        const [entry] = plan([{ kind: "trigger", trigger: WEBHOOK }]);

        expect(entry?.plan).toStrictEqual({ create: WEBHOOK, kind: "trigger" });
    });

    it("makes a group chat ready only when every participant is a selected, importable skill", () => {
        const items: BundleItem[] = [skill("alpha"), skill("beta"), { group: GROUP, kind: "group" }];
        const all = plan(items);

        expect(entryOf(all, "group:2").problems).toStrictEqual([]);
        expect(entryOf(all, "group:2").requires).toStrictEqual(["skill:0", "skill:1"]);
        expect(entryOf(all, "group:2").plan).toMatchObject({ create: { participantKeys: ["skill:0", "skill:1"] }, kind: "group" });

        const partial = plan(items, ["skill:0", "group:2"]);

        expect(entryOf(partial, "group:2").problems.join(" ")).toMatch(RE_5);
    });

    it("blocks a group chat whose participant is not in the bundle, is blocked, or is too few", () => {
        const missing = plan([skill("alpha"), { group: GROUP, kind: "group" }]);
        const few = plan([skill("alpha"), { group: { ...GROUP, participants: ["alpha"] }, kind: "group" }]);
        const blockedSkill = plan([skill("alpha"), skill("beta"), { group: GROUP, kind: "group" }], ["skill:0", "skill:1", "group:2"], {
            existingSkillCount: 5,
            skillLimit: 5,
        });

        expect(entryOf(missing, "group:1").problems.join(" ")).toMatch(RE_6);
        expect(entryOf(few, "group:1").problems.join(" ")).toMatch(RE_7);
        expect(entryOf(blockedSkill, "group:2").problems.join(" ")).toMatch(RE_8);
    });

    it("checks a group chat's model and synthesizer", () => {
        const items: BundleItem[] = [skill("alpha"), skill("beta")];
        const entries = plan([
            ...items,
            { group: { ...GROUP, model: "gone" }, kind: "group" },
            { group: { ...GROUP, mode: "parallel", synthesizer: "stranger" }, kind: "group" },
        ]);

        expect(entryOf(entries, "group:2").problems.join(" ")).toMatch(RE_4);
        expect(entryOf(entries, "group:3").problems.join(" ")).toMatch(RE_9);
    });
});

const ALL = new Set(["group:1", "skill:2", "skill:3", "trigger:0"]);

const fakeOps = (overrides: Partial<BundleOps> = {}) => {
    const calls: string[] = [];
    let counter = 0;
    const next = (): number => {
        counter += 1;

        return counter;
    };
    const ops: BundleOps = {
        createGroupChat: vi.fn(async (args) => {
            calls.push(`createGroup:${args.skillIds.join("+")}`);

            return `thread-${String(next())}`;
        }),
        createSkill: vi.fn(async (args) => {
            calls.push(`createSkill:${args.slug}`);

            return `skill-${String(next())}`;
        }),
        createTrigger: vi.fn(async (args) => {
            calls.push(`createTrigger:${args.name}`);

            return { triggerId: `trigger-${String(next())}`, ...(args.type === "webhook" && { webhookSecret: "plaintext-secret" }) };
        }),
        deleteGroupChat: vi.fn(async (id) => {
            calls.push(`deleteGroup:${id}`);
        }),
        deleteSkill: vi.fn(async (id) => {
            calls.push(`deleteSkill:${id}`);
        }),
        deleteTrigger: vi.fn(async (id) => {
            calls.push(`deleteTrigger:${id}`);
        }),
        ...overrides,
    };

    return { calls, ops };
};

describe("the import", () => {
    const items: BundleItem[] = [{ kind: "trigger", trigger: WEBHOOK }, { group: GROUP, kind: "group" }, skill("alpha"), skill("beta")];

    it("creates skills, then group chats on the new skill ids, then triggers", async () => {
        const { calls, ops } = fakeOps();
        const created = await runBundleImport(plan(items), ALL, ops);

        expect(calls).toStrictEqual(["createSkill:alpha", "createSkill:beta", "createGroup:skill-1+skill-2", "createTrigger:On PR"]);
        expect(created.map((item) => item.kind)).toStrictEqual(["skill", "skill", "group", "trigger"]);
    });

    it("hands back a new webhook's secret once, on its item", async () => {
        const { ops } = fakeOps();
        const created = await runBundleImport(plan(items), ALL, ops);

        expect(created.find((item) => item.kind === "trigger")?.webhookSecret).toBe("plaintext-secret");
        expect(created.filter((item) => item.webhookSecret !== undefined)).toHaveLength(1);
    });

    it("imports only the selected, ready entries", async () => {
        const { calls, ops } = fakeOps();

        await runBundleImport(plan(items, ["skill:2"]), new Set(["skill:2"]), ops);

        expect(calls).toStrictEqual(["createSkill:alpha"]);
    });

    it("removes everything created so far, newest first, when a later item fails", async () => {
        const { calls, ops } = fakeOps({
            createGroupChat: vi.fn(async () => {
                throw new Error("Rate limit exceeded");
            }),
        });

        await expect(runBundleImport(plan(items), ALL, ops)).rejects.toThrow(RE_10);
        expect(calls).toStrictEqual(["createSkill:alpha", "createSkill:beta", "deleteSkill:skill-2", "deleteSkill:skill-1"]);
        expect(ops.createTrigger).not.toHaveBeenCalled();
    });

    it("rolls back groups and skills when the last item, a trigger, fails", async () => {
        const { calls, ops } = fakeOps({
            createTrigger: vi.fn(async () => {
                throw new Error("boom");
            }),
        });

        await expect(runBundleImport(plan(items), ALL, ops)).rejects.toBeInstanceOf(BundleImportError);
        expect(calls).toStrictEqual([
            "createSkill:alpha",
            "createSkill:beta",
            "createGroup:skill-1+skill-2",
            "deleteGroup:thread-3",
            "deleteSkill:skill-2",
            "deleteSkill:skill-1",
        ]);
    });

    it("keeps the skills a group chat it could not remove still names", async () => {
        const { ops } = fakeOps({
            createTrigger: vi.fn(async () => {
                throw new Error("boom");
            }),
            deleteGroupChat: vi.fn(async () => {
                throw new Error("gone wrong");
            }),
        });
        const error = (await runBundleImport(plan(items), ALL, ops).catch((error_: unknown) => error_)) as BundleImportError;

        expect(ops.deleteSkill).not.toHaveBeenCalled();
        expect(error.leftBehind).toStrictEqual(expect.arrayContaining(["Panel", "alpha", "beta"]));
    });

    it("keeps the skills of a group chat that has messages by now, and says so", async () => {
        const { ops } = fakeOps({
            createTrigger: vi.fn(async () => {
                throw new Error("boom");
            }),
            deleteGroupChat: vi.fn(async () => {
                return { kept: true };
            }),
        });
        const error = (await runBundleImport(plan(items), ALL, ops).catch((error_: unknown) => error_)) as BundleImportError;

        expect(ops.deleteSkill).not.toHaveBeenCalled();
        expect(error.leftBehind).toStrictEqual(expect.arrayContaining(["Panel", "alpha", "beta"]));
        expect(error.message).toMatch(RE_KEPT);
        expect(mayRetryImport(error)).toBe(false);
    });

    it("keeps only the skills of the group chat that stays, and deletes the rest", async () => {
        const two: BundleItem[] = [
            skill("alpha"),
            skill("beta"),
            skill("gamma"),
            skill("delta"),
            { group: GROUP, kind: "group" },
            { group: { ...GROUP, participants: ["gamma", "delta"], title: "Second" }, kind: "group" },
            { kind: "trigger", trigger: WEBHOOK },
        ];
        const { calls, ops } = fakeOps({
            createTrigger: vi.fn(async () => {
                throw new Error("boom");
            }),
            deleteGroupChat: vi.fn(async (id) => {
                calls.push(`deleteGroup:${id}`);

                return { kept: id === "thread-5" };
            }),
        });
        const everything = new Set(["group:4", "group:5", "skill:0", "skill:1", "skill:2", "skill:3", "trigger:6"]);
        const error = (await runBundleImport(plan(two), everything, ops).catch((error_: unknown) => error_)) as BundleImportError;

        // thread-5 is "Panel" (alpha, beta = skill-1, skill-2): kept. "Second" (gamma, delta = skill-3, skill-4) is deleted with its skills.
        expect(calls).toContain("deleteGroup:thread-6");
        expect(calls).toContain("deleteSkill:skill-3");
        expect(calls).toContain("deleteSkill:skill-4");
        expect(calls).not.toContain("deleteSkill:skill-1");
        expect(calls).not.toContain("deleteSkill:skill-2");
        expect(error.leftBehind.toSorted(byText)).toStrictEqual(["alpha", "beta", "Panel"]);
        expect(error.message).not.toContain("by hand");
        expect(error.message).not.toContain("switched off");
        expect(error.message).toMatch(RE_KEPT);
    });

    it("names what it could not remove again", async () => {
        const { ops } = fakeOps({
            createTrigger: vi.fn(async () => {
                throw new Error("boom");
            }),
            deleteSkill: vi.fn(async (id) => {
                if (id === "skill-1") {
                    throw new Error("rate limited");
                }
            }),
        });
        const error = (await runBundleImport(plan(items), ALL, ops).catch((error_: unknown) => error_)) as BundleImportError;

        expect(error).toBeInstanceOf(BundleImportError);
        expect(error.leftBehind).toStrictEqual(["alpha"]);
        expect(error.message).toMatch(RE_11);
        expect(error.message).toMatch(RE_16);
        expect(error.message).not.toContain("They are disabled");
        expect(ops.deleteSkill).toHaveBeenCalledTimes(2);
    });
});

describe("mayRetryImport", () => {
    it("frees the import id after a clean rollback or an unrelated failure", () => {
        expect(mayRetryImport(new BundleImportError("failed", []))).toBe(true);
        expect(mayRetryImport(new Error("network"))).toBe(true);
    });

    it("keeps the import id while rollback left created items behind, so a retry cannot copy them", () => {
        expect(mayRetryImport(new BundleImportError("failed", ["alpha"]))).toBe(false);
    });
});

describe("assertSelectionImportable", () => {
    it("refuses a selection that holds a blocked item, an unknown key, or nothing", () => {
        const entries = plan([skill("alpha"), { kind: "trigger", trigger: { ...SCHEDULE, model: "gone" } }]);

        expect(() => assertSelectionImportable(entries, new Set(["skill:0"]))).not.toThrow();
        expect(() => assertSelectionImportable(entries, new Set(["skill:0", "trigger:1"]))).toThrow(RE_12);
        expect(() => assertSelectionImportable(entries, new Set(["skill:9"]))).toThrow(RE_13);
        expect(() => assertSelectionImportable(entries, new Set())).toThrow(RE_14);
    });
});
