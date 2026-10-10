/**
 * The group-chat turn loop (`run.ts`), driven end to end against the real
 * schema: the real agent (`agent/client`) saves real rows through the real
 * `agent/messages` procedures, the real `persistentChunks` stream is written,
 * and the real approval snapshot is recorded and resumed.
 *
 * Faked at the edges only:
 * - the language models (`ai/test` mocks in `test-models.ts`, scripted per participant and for
 *   the router) — `get-agent.ts` and `lib/utility-model.ts` are the two places a
 *   model is chosen;
 * - `buildAgentTools` (MCP servers and per-tool permissions are not under test);
 * - the user-preference and thread-settings reads, which touch encrypted keys;
 * - `skills` rows, served from memory through `skill-reader.ts` — a `.global()`
 *   (D1) table the harness cannot store. `userSkills` (the opt-in) is real;
 * - the session, read straight off the harness identity (`user` is D1 too).
 */
import { lunoraTest } from "@lunora/testing";
import type { ToolSet } from "ai";
import { tool } from "ai";
import { v } from "lunorash/server";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import z from "zod/v4";

import { internalMutation, internalQuery } from "../../_generated/server";
import { buildBranchTree } from "../../agent/branch-tree";
import schema from "../../schema";
import { mappedReferences } from "../../../test/registered-api";

/**
 * The harness's `ctx.runQuery` takes the REGISTERED procedure object, not a
 * generated reference. Both `api.<module>.<fn>` and `internal.<module>.<fn>`
 * resolve through this registry, filled from the real modules in `beforeAll`.
 */
const { registeredOnly, registry } = vi.hoisted(() => {
    const procedures = new Map<string, unknown>();

    return {
        registeredOnly: (reference: { __lunoraRef: string }): unknown => {
            if (!procedures.has(reference.__lunoraRef)) {
                throw new Error(`run.test: no procedure registered for ${reference.__lunoraRef}`);
            }

            return procedures.get(reference.__lunoraRef);
        },
        registry: procedures,
    };
});

vi.mock("../../_generated/api", async (importOriginal) => mappedReferences(await importOriginal(), registeredOnly));
vi.mock("../../_generated/internal", async (importOriginal) => mappedReferences(await importOriginal(), registeredOnly));

/** `skills` rows by id — the D1 table the harness cannot hold. */
const skillRows = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("./skill-reader", () => {
    return {
        readSkills: async (_context: unknown, ids: ReadonlyArray<string>) => ids.map((id) => skillRows.get(id) ?? null),
    };
});

const { sessionFrom } = vi.hoisted(() => {
    return {
        sessionFrom: async (context: { auth: { userId?: string | null } }) =>
            context.auth.userId ? { activeOrganization: null, id: context.auth.userId, isAdmin: false, userId: context.auth.userId } : null,
    };
});

vi.mock("../../lib/crpc-auth-helpers", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../lib/crpc-auth-helpers")>()),
        getSessionUser: sessionFrom,
        getSessionUserForQuery: sessionFrom,
        getSessionUserForQueryLite: sessionFrom,
    };
});

vi.mock("../../lib/rate-limiter", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("../../lib/rate-limiter")>()),
        rateLimitGuard: async () => undefined,
    };
});

/** The per-reply daily charge (`chat/daily-charge.ts` reads the D1 `user` table): counted, and refusable. */
const replyCharges = vi.hoisted(() => {
    return { allow: Infinity, calls: 0 };
});

/** Per-participant scripts, keyed by the skill instructions `getAgent` receives. */
const speakerModels = vi.hoisted(() => new Map<string, unknown>());
const speakerTools = vi.hoisted(() => new Map<string, unknown>());
const routerScript = vi.hoisted(() => {
    return { calls: 0, speakers: [] as string[] };
});

vi.mock("../lib/get-agent", () => {
    return {
        default: async (model: string, options: { maxSteps?: number; skillContext?: { instructions: string }; tools?: ToolSet }) => {
            // Imported at call time: the agent client and `agent/messages` import
            // each other, and loading them from a mock factory breaks that cycle.
            const { Agent } = await import("../../agent/client");
            const { api } = await import("../../_generated/api");
            const { dispatchingModel } = await import("./test-models");

            // The model is picked per CALL from the system prompt, which carries
            // the participant's instructions — also on a continuation, whose
            // agent gets its instructions from the snapshot after construction.
            return new Agent(api as never, {
                instructions: options.skillContext?.instructions ?? "",
                languageModel: dispatchingModel(speakerModels as never) as never,
                maxSteps: options.maxSteps ?? 5,
                name: model,
                tools: options.tools,
            });
        },
    };
});

vi.mock("../lib/agent-tools", () => {
    return {
        buildAgentTools: async () => {
            // Both the fresh run and the snapshot rebuild get the approval-gated tool.
            const tools = (speakerTools.get("all") ?? {}) as ToolSet;

            return { mcpClients: [], mcpLabels: {}, mcpServerNames: [], permissionKeys: {}, tools };
        },
    };
});

vi.mock("../../lib/utility-model", () => {
    return {
        getUtilityModel: async () => {
            routerScript.calls += 1;

            const { routerModel } = await import("./test-models");

            return routerModel(routerScript.speakers);
        },
    };
});

const { continueGroupAfterToolApproval, runGroupTurn } = await import("./run");

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-user";

let harness: Harness;
let threadId: string;
let promptId: string;
let streamId: string;
const skillIds: Record<string, string> = {};

const { scriptedModel, textStep, toolCallStep } = await import("./test-models");

type ScriptedModel = ReturnType<typeof scriptedModel>;

/** Fakes for reads the loop makes that are not under test. */
const fakeProcedures = () => {
    const prefs = internalQuery.input({ userId: v.string() }).query(async () => {
        return { language: undefined, location: undefined, memoryEnabled: false, timezone: undefined };
    });
    const agentPrefs = internalQuery.input({ userId: v.string() }).query(async () => {
        return { autoMediaEnrichment: false };
    });
    const keys = internalQuery.input({ userId: v.string() }).query(async () => {
        return {};
    });
    const threadSettings = internalQuery.input({ threadId: v.string() }).query(async () => null);

    registry.set("auth_functions:getUserPreferencesQuery", prefs);
    registry.set("auth_functions:getAgentModulePreferencesQuery", agentPrefs);
    registry.set("auth_functions:getDecryptedProviderKeysQuery", keys);
    registry.set("chat_functions:getThreadSettings", threadSettings);
    // Scheduled after the turn; the fake scheduler only runs it on `runPending()`.
    registry.set("chat_functions:generateFollowupSuggestionsForThread", threadSettings);
    // `afterRun` notes Daily Brief activity after every reply; likewise only scheduled.
    registry.set("notifications_daily_brief:noteDailyBriefActivity", prefs);
    // …and the per-day usage rollup (`usage/activity.ts`).
    registry.set("usage_activity:recordReplyUsage", prefs);
    registry.set(
        "chat_daily_charge:chargeDailyUnit",
        internalMutation.input({ kind: v.string(), organizationId: v.optional(v.string()), userId: v.string() }).mutation(async () => {
            replyCharges.calls += 1;

            return replyCharges.calls <= replyCharges.allow;
        }),
    );
};

beforeAll(async () => {
    const modules: Record<string, Record<string, unknown>> = {
        agent_branches: await import("../../agent/branches"),
        agent_messages: await import("../../agent/messages"),
        agent_streams: await import("../../agent/streams"),
        agent_threads: await import("../../agent/threads"),
        chat_group_functions: await import("./functions"),
        chat_mcp_tool_labels: await import("../mcp-tool-labels"),
        chat_streaming_persistent_library: await import("../streaming/persistent/library"),
        chat_tool_permissions: await import("../tool-permissions"),
    };

    for (const [module, exports] of Object.entries(modules)) {
        for (const [name, value] of Object.entries(exports)) {
            registry.set(`${module}:${name}`, value);
        }
    }

    fakeProcedures();
});

const insertSkill = async (slug: string) => {
    const id = `skill_${slug}`;

    skillRows.set(id, { _id: id, description: `The ${slug}`, instructions: `INSTR:${slug}`, name: slug.toUpperCase(), slug, userId: OWNER });
    await harness.run(async (ctx: any) => await ctx.db.insert("userSkills", { addedAt: 1, enabled: true, skillId: id, userId: OWNER }));
    skillIds[slug] = id;

    return id;
};

const setGroup = async (
    mode: "debate" | "mention-only" | "parallel" | "round-robin" | "supervisor",
    slugs: string[],
    options: { debateRounds?: number; synthesizer?: string } = {},
) =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db.patch(threadId, {
                groupChat: {
                    ...(options.debateRounds !== undefined && { debateRounds: options.debateRounds }),
                    ...(options.synthesizer !== undefined && { synthesizerSkillId: skillIds[options.synthesizer] }),
                    mode,
                    participants: slugs.map((slug) => {
                        return { addedAt: 1, skillId: skillIds[slug] };
                    }),
                },
            }),
    );

const groupConfig = async () =>
    await harness.run(async (ctx: any) => {
        const { getGroupRunConfig } = await import("./functions");

        return await ctx.runQuery(getGroupRunConfig, { threadId, userId: OWNER });
    });

const runTurn = async (userPrompt = "Draft a tagline") => {
    const config = await groupConfig();

    if (!config) {
        throw new Error("not a group thread");
    }

    await harness.action(
        async (ctx: any) =>
            await runGroupTurn(
                ctx,
                { isAnonymous: false, messageId: promptId, streamId, streamingConfig: { model: "test-model" }, threadId, userId: OWNER, userPrompt },
                config as never,
            ),
    );
};

const rows = async (): Promise<any[]> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("messages")
                .withIndex("by_threadId_order_stepOrder", (q: any) => q.eq("threadId", threadId))
                .collect(),
    );

const assistantRows = async () => {
    const all = await rows();

    return all.filter((row) => row.message?.role === "assistant");
};

/** Who replied this turn, in order. */
const speakersSaid = async () => {
    const replies = await assistantRows();

    return replies.map((row) => row.agentName);
};

const chunks = async (): Promise<any[]> =>
    await harness.run(
        async (ctx: any) =>
            await ctx.db
                .query("persistentChunks")
                .withIndex("by_streamId_seq", (q: any) => q.eq("streamId", streamId))
                .collect(),
    );

const statusOf = async (id: string) =>
    await harness.run(async (ctx: any) => {
        const stream = await ctx.db.get(id);

        return stream.status;
    });

const streamStatus = async () => await statusOf(streamId);

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    skillRows.clear();
    speakerModels.clear();
    speakerTools.clear();
    routerScript.calls = 0;
    routerScript.speakers = [];
    replyCharges.allow = Infinity;
    replyCharges.calls = 0;

    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { status: "running", title: "Group", userId: OWNER }));
    promptId = await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("messages", {
                message: { content: "Draft a tagline", role: "user" },
                order: 0,
                status: "success",
                stepOrder: 0,
                text: "Draft a tagline",
                threadId,
                tool: false,
                userId: OWNER,
            }),
    );
    streamId = await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId: promptId,
                status: "pending",
                streamingConfig: { contentType: "text", model: "test-model" },
                threadId,
                userId: OWNER,
            }),
    );

    for (const slug of ["writer", "checker", "reviewer", "designer", "editor"]) {
        await insertSkill(slug);
        speakerModels.set(`INSTR:${slug}`, scriptedModel([textStep(`${slug} says hi.`)]));
    }
});

afterEach(() => {
    harness.close();
});

describe("runGroupTurn — supervisor with two routed speakers", () => {
    it("saves both replies in order, labelled, the second continuing the first on the same branch", async () => {
        await setGroup("supervisor", ["writer", "checker", "reviewer"]);
        routerScript.speakers = ["p2", "p1"];

        await runTurn();

        expect(routerScript.calls).toBe(1);

        const replies = await assistantRows();

        expect(replies.map((row) => [row.agentName, row.speakerSkillId, row.text])).toStrictEqual([
            ["CHECKER", skillIds.checker, "checker says hi."],
            ["WRITER", skillIds.writer, "writer says hi."],
        ]);
        // Speaker 2 is a new turn order, explicitly parented on speaker 1's row…
        expect(replies[1].order).toBeGreaterThan(replies[0].order);
        expect(replies[1].parentMessageId).toBe(replies[0]._id);

        // …so the tree has no fork: nobody has a sibling (a regenerate would).
        const all = await rows();
        const tree = buildBranchTree(all);

        for (const row of all) {
            const parent = tree.parentOf(row._id);

            expect(parent === undefined ? [] : tree.childrenOf(parent)).toHaveLength(parent === undefined ? 0 : 1);
        }

        // One stream, a marker per speaker, closed once at the end.
        const markers = await chunks().then((list) => list.filter((chunk) => chunk.speaker).map((chunk) => chunk.speaker.name));

        expect(markers).toStrictEqual(["CHECKER", "WRITER"]);
        expect(await streamStatus()).toBe("done");
    });

    it("shows the second speaker the first one's reply as labelled data, not as its own words", async () => {
        await setGroup("supervisor", ["writer", "checker"]);
        routerScript.speakers = ["p2", "p1"];

        await runTurn();

        const writerModel = speakerModels.get("INSTR:writer") as ScriptedModel;
        const prompt = JSON.stringify(writerModel.doStreamCalls[0]?.prompt);

        expect(prompt).toContain(String.raw`participant_message from=\"CHECKER\"`);
        expect(prompt).toContain("checker says hi.");
    });
});

describe("runGroupTurn — cap and mentions", () => {
    it("runs at most three speakers even when the router asks for five", async () => {
        await setGroup("supervisor", ["writer", "checker", "reviewer", "designer", "editor"]);
        routerScript.speakers = ["p1", "p2", "p3", "p4", "p5"];

        await runTurn();

        expect(await speakersSaid()).toStrictEqual(["WRITER", "CHECKER", "REVIEWER"]);
        expect((speakerModels.get("INSTR:designer") as ScriptedModel).doStreamCalls).toHaveLength(0);
        expect((speakerModels.get("INSTR:editor") as ScriptedModel).doStreamCalls).toHaveLength(0);
    });

    it("lets an @mention pick the speaker and never asks the router", async () => {
        await setGroup("supervisor", ["writer", "checker", "designer"]);
        routerScript.speakers = ["p1", "p2"];

        await runTurn("What do you think, @designer?");

        expect(routerScript.calls).toBe(0);
        expect(await speakersSaid()).toStrictEqual(["DESIGNER"]);
    });
});

describe("runGroupTurn — stop", () => {
    it("lets the current speaker finish and never starts the next one", async () => {
        await setGroup("supervisor", ["writer", "checker"]);
        routerScript.speakers = ["p1", "p2"];

        // The user presses Stop while the writer is talking.
        speakerModels.set(
            "INSTR:writer",
            scriptedModel([textStep("writer says hi.")], async () => {
                await harness.run(async (ctx: any) => {
                    const thread = await ctx.db.get(threadId);

                    await ctx.db.patch(threadId, { groupChat: { ...thread.groupChat, stopRequestedAt: Date.now() } });
                });
            }),
        );

        await runTurn();

        expect(await speakersSaid()).toStrictEqual(["WRITER"]);
        expect((speakerModels.get("INSTR:checker") as ScriptedModel).doStreamCalls).toHaveLength(0);
        expect(await streamStatus()).toBe("done");
    });

    it("does not carry a stop from an earlier turn into the next one", async () => {
        await setGroup("supervisor", ["writer", "checker"]);
        await harness.run(async (ctx: any) => {
            const thread = await ctx.db.get(threadId);

            await ctx.db.patch(threadId, { groupChat: { ...thread.groupChat, stopRequestedAt: Date.now() - 60_000 } });
        });
        routerScript.speakers = ["p1", "p2"];

        await runTurn();

        expect(await speakersSaid()).toStrictEqual(["WRITER", "CHECKER"]);
    });
});

describe("runGroupTurn — tool approval inside a group turn", () => {
    const setUpPausingWriter = async () => {
        await setGroup("supervisor", ["writer", "checker"]);
        routerScript.speakers = ["p1", "p2"];
        speakerTools.set("all", {
            dangerous: tool({ description: "needs approval", execute: async () => "done", inputSchema: z.object({}), needsApproval: true }),
        });
        speakerModels.set("INSTR:writer", scriptedModel([toolCallStep("dangerous", "call-1"), textStep("writer after the tool.")]));
    };

    const approvalRow = async () =>
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("toolApprovalRuns").collect();

            return row;
        });

    const resume = async (approved: boolean) => {
        const row = await approvalRow();
        const resumeStreamId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: row.approvalId,
                    status: "pending",
                    streamingConfig: { contentType: "text", model: row.config.model },
                    threadId,
                    userId: OWNER,
                }),
        );

        await harness.action(
            async (ctx: any) =>
                await continueGroupAfterToolApproval(ctx, {
                    approvalId: row.approvalId,
                    approved,
                    config: row.config,
                    streamId: resumeStreamId,
                    threadId,
                    userId: OWNER,
                }),
        );

        return resumeStreamId;
    };

    it("pauses the turn, recording the paused participant and the queue behind it", async () => {
        await setUpPausingWriter();

        await runTurn();

        const row = await approvalRow();

        expect(row.config.group).toMatchObject({
            baseModel: "test-model",
            queue: [skillIds.checker],
            skillId: skillIds.writer,
            spokenSkillIds: [skillIds.writer],
        });
        expect((speakerModels.get("INSTR:checker") as ScriptedModel).doStreamCalls).toHaveLength(0);
        // The pause closes the stream; the continuation opens its own.
        expect(await streamStatus()).toBe("done");
    });

    it("resumes the paused participant, then runs the rest of the queue without re-routing", async () => {
        await setUpPausingWriter();
        await runTurn();

        const resumeStreamId = await resume(true);

        expect(routerScript.calls).toBe(1);

        // The approved tool ran.
        const toolResult = await rows().then((all) => all.find((row) => row.message?.role === "tool"));

        expect(JSON.stringify(toolResult?.message.content)).toContain("done");
        // …and is labelled as the paused participant's, like the rest of its reply.
        expect([toolResult?.agentName, toolResult?.speakerSkillId]).toStrictEqual(["WRITER", skillIds.writer]);

        const replies = await assistantRows().then((all) => all.filter((row) => row.text));

        expect(replies.map((row) => [row.agentName, row.speakerSkillId, row.text])).toStrictEqual([
            ["WRITER", skillIds.writer, "writer after the tool."],
            ["CHECKER", skillIds.checker, "checker says hi."],
        ]);
        // The checker continues from the writer's resumed reply, on the same branch.
        expect(replies[1].parentMessageId).toBe(replies[0]._id);

        const resumed = await harness.run(
            async (ctx: any) =>
                await ctx.db
                    .query("persistentChunks")
                    .withIndex("by_streamId_seq", (q: any) => q.eq("streamId", resumeStreamId))
                    .collect(),
        );

        expect(resumed.filter((chunk: any) => chunk.speaker).map((chunk: any) => chunk.speaker.name)).toStrictEqual(["WRITER", "CHECKER"]);
        expect(await statusOf(resumeStreamId)).toBe("done");
    });

    it("shows the resumed participant the others as labelled data and its own tool call intact", async () => {
        await setUpPausingWriter();
        // The checker speaks first, so its reply is in the history the resumed writer reads.
        routerScript.speakers = ["p2", "p1"];

        await runTurn();
        await resume(true);

        const writerModel = speakerModels.get("INSTR:writer") as ScriptedModel;
        const resumedPrompt = writerModel.doStreamCalls[1]?.prompt ?? [];
        const serialised = JSON.stringify(resumedPrompt);

        expect(serialised).toContain(String.raw`participant_message from=\"CHECKER\"`);
        // Never the checker's words as an assistant turn of the writer's own.
        expect(
            resumedPrompt.filter((message) => message.role === "assistant").some((message) => JSON.stringify(message.content).includes("checker says hi.")),
        ).toBe(false);
        // The approved call reaches the model with its result, so the step can continue.
        expect(resumedPrompt.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("call-1"))).toBe(true);
        expect(resumedPrompt.some((message) => message.role === "tool" && JSON.stringify(message.content).includes("done"))).toBe(true);
    });

    it("fails the continuation cleanly when the paused participant lost access meanwhile", async () => {
        await setUpPausingWriter();
        await runTurn();
        skillRows.delete(skillIds.writer!);

        await expect(resume(true)).rejects.toThrow("Participant is no longer available");
        expect((speakerModels.get("INSTR:checker") as ScriptedModel).doStreamCalls).toHaveLength(0);
    });
});

describe("runGroupTurn — participant access between turns", () => {
    it("skips a participant whose skill was disabled or deleted since it joined", async () => {
        await setGroup("round-robin", ["writer", "checker", "reviewer"]);
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db
                .query("userSkills")
                .withIndex("by_user_and_skill", (q: any) => q.eq("userId", OWNER).eq("skillId", skillIds.writer))
                .collect();

            await ctx.db.patch(row._id, { enabled: false });
        });
        skillRows.delete(skillIds.checker!);

        const config: any = await groupConfig();

        expect(config.participants.map((p: any) => p.skillId)).toStrictEqual([skillIds.reviewer]);

        // Mentioning the disabled one does not bring it back.
        await runTurn("@writer please");

        expect(await speakersSaid()).toStrictEqual(["REVIEWER"]);
        expect((speakerModels.get("INSTR:writer") as ScriptedModel).doStreamCalls).toHaveLength(0);
    });

    it("refuses a skill shared by someone else and not opted into", async () => {
        skillRows.set("skill_foreign", {
            _id: "skill_foreign",
            description: "",
            instructions: "x",
            name: "FOREIGN",
            slug: "foreign",
            userId: "someone-else",
            visibility: "private",
        });
        await harness.run(async (ctx: any) => await ctx.db.insert("userSkills", { addedAt: 1, enabled: true, skillId: "skill_foreign", userId: OWNER }));
        skillIds.foreign = "skill_foreign";
        await setGroup("supervisor", ["writer", "foreign"]);

        const config: any = await groupConfig();

        expect(config.participants.map((p: any) => p.skillId)).toStrictEqual([skillIds.writer]);
    });

    it("errors the turn cleanly when no participant is usable any more", async () => {
        await setGroup("supervisor", ["writer"]);
        skillRows.delete(skillIds.writer!);

        await expect(runTurn()).rejects.toThrow("None of this group's participants are available");
        expect(await assistantRows()).toHaveLength(0);
    });
});

describe("participant management", () => {
    const STRANGER = "stranger-user";

    it("lets only the owner change participants or mode", async () => {
        await setGroup("supervisor", ["writer", "checker"]);
        const { updateGroupChat } = await import("./functions");

        await expect(
            harness
                .withIdentity({ userId: STRANGER } as never)
                .mutation(updateGroupChat as never, { mode: "round-robin", skillIds: [skillIds.writer], threadId } as never),
            // A stranger holds no grant, so row-level security hides the thread
            // itself: the same answer as a thread that does not exist.
        ).rejects.toThrow("Thread not found");

        await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(updateGroupChat as never, { mode: "round-robin", skillIds: [skillIds.writer, skillIds.reviewer], threadId } as never);

        const thread: any = await harness.run(async (ctx: any) => await ctx.db.get(threadId));

        expect(thread.groupChat.mode).toBe("round-robin");
        expect(thread.groupChat.participants.map((p: any) => p.skillId)).toStrictEqual([skillIds.writer, skillIds.reviewer]);
    });

    it("refuses to add a skill the owner has not enabled", async () => {
        await setGroup("supervisor", ["writer"]);
        skillRows.set("skill_off", { _id: "skill_off", description: "", instructions: "x", name: "OFF", slug: "off", userId: OWNER });
        const { updateGroupChat } = await import("./functions");

        await expect(
            harness
                .withIdentity({ userId: OWNER } as never)
                .mutation(updateGroupChat as never, { mode: "supervisor", skillIds: [skillIds.writer, "skill_off"], threadId } as never),
        ).rejects.toThrow("not available");
    });

    it("accepts an enabled skill however many other skills the owner has enabled", async () => {
        await setGroup("supervisor", ["writer"]);

        // More enabled skills than any capped list reads, all ahead of the one added.
        await harness.run(async (ctx: any) => {
            for (let index = 0; index < 60; index += 1) {
                await ctx.db.insert("userSkills", { addedAt: 1, enabled: true, skillId: `skill_filler_${String(index)}`, userId: OWNER });
            }
        });

        const late = await insertSkill("late");
        const { updateGroupChat } = await import("./functions");

        await harness
            .withIdentity({ userId: OWNER } as never)
            .mutation(updateGroupChat as never, { mode: "supervisor", skillIds: [skillIds.writer, late], threadId } as never);

        const config: any = await groupConfig();

        expect(config.participants.map((participant: { skillId: string }) => participant.skillId)).toStrictEqual([skillIds.writer, late]);
    });

    it("does not let a stranger stop someone else's turn", async () => {
        await setGroup("supervisor", ["writer"]);
        const { stopGroupTurn } = await import("./functions");

        await expect(harness.withIdentity({ userId: STRANGER } as never).mutation(stopGroupTurn as never, { threadId } as never)).rejects.toThrow(
            "Not allowed",
        );
    });
});

/** The system prompt and the conversation one participant's `n`-th model call received. */
const promptOf = (slug: string, call = 0) => {
    const model = speakerModels.get(`INSTR:${slug}`) as ScriptedModel;
    const prompt = model.doStreamCalls[call]?.prompt ?? [];

    return {
        conversation: JSON.stringify(prompt.filter((message: any) => message.role !== "system")),
        system: JSON.stringify(prompt.filter((message: any) => message.role === "system")),
    };
};

describe("runGroupTurn — billing", () => {
    it("charges every reply after the first, so a five-reply debate costs five", async () => {
        await setGroup("debate", ["writer", "checker", "reviewer"], { debateRounds: 2, synthesizer: "reviewer" });

        await runTurn();

        // `/chat/start` charged the first; the other four are charged here.
        expect(await speakersSaid()).toHaveLength(5);
        expect(replyCharges.calls).toBe(4);
    });

    it("ends the turn when the daily quota runs out between replies", async () => {
        await setGroup("parallel", ["writer", "checker", "reviewer"]);
        replyCharges.allow = 1;

        await runTurn();

        expect(await speakersSaid()).toStrictEqual(["WRITER", "CHECKER"]);
        expect(await streamStatus()).toBe("done");
    });
});

describe("runGroupTurn — parallel", () => {
    it("lets every participant answer without seeing the others, then the synthesizer merge them all", async () => {
        await setGroup("parallel", ["writer", "checker", "reviewer"], { synthesizer: "reviewer" });
        speakerModels.set("INSTR:reviewer", scriptedModel([textStep("reviewer says hi."), textStep("merged answer.")]));

        await runTurn();

        expect(routerScript.calls).toBe(0);
        expect(await speakersSaid()).toStrictEqual(["WRITER", "CHECKER", "REVIEWER", "REVIEWER"]);

        // Independent: the checker never saw the writer's answer to this message…
        expect(promptOf("checker").conversation).not.toContain("writer says hi.");
        expect(promptOf("checker").system).toContain("You will not see their answers");

        // …while the synthesis sees every answer, labelled.
        const synthesis = promptOf("reviewer", 1);

        expect(synthesis.conversation).toContain("writer says hi.");
        expect(synthesis.conversation).toContain("checker says hi.");
        expect(synthesis.system).toContain("Merge their answers");
        expect(await streamStatus()).toBe("done");
    });

    it("has no merge step without a synthesizer", async () => {
        await setGroup("parallel", ["writer", "checker"]);

        await runTurn();

        expect(await speakersSaid()).toStrictEqual(["WRITER", "CHECKER"]);
    });
});

describe("runGroupTurn — debate", () => {
    it("alternates for and against for the configured rounds, then the synthesizer weighs both sides", async () => {
        await setGroup("debate", ["writer", "checker", "reviewer"], { debateRounds: 2, synthesizer: "reviewer" });
        speakerModels.set("INSTR:writer", scriptedModel([textStep("pro round one."), textStep("pro round two.")]));
        speakerModels.set("INSTR:checker", scriptedModel([textStep("contra round one."), textStep("contra round two.")]));

        await runTurn("Should we rewrite it in Rust?");

        expect(await speakersSaid()).toStrictEqual(["WRITER", "CHECKER", "WRITER", "CHECKER", "REVIEWER"]);
        expect(promptOf("writer").system).toContain("You argue FOR");
        expect(promptOf("writer", 1).system).toContain("round 2 of 2");
        expect(promptOf("checker").system).toContain("You argue AGAINST");
        // Debaters answer each other: round two sees the other side's round one.
        expect(promptOf("writer", 1).conversation).toContain("contra round one.");

        const synthesis = promptOf("reviewer");

        expect(synthesis.system).toContain("debated");
        expect(synthesis.conversation).toContain("pro round two.");
        expect(synthesis.conversation).toContain("contra round two.");

        // Every reply continues the previous one on the same branch.
        const replies = await assistantRows();

        for (let index = 1; index < replies.length; index += 1) {
            expect(replies[index].parentMessageId).toBe(replies[index - 1]._id);
        }

        expect(await streamStatus()).toBe("done");
    });

    it("records the paused step and the steps behind it, and resumes the debate where it stopped", async () => {
        await setGroup("debate", ["writer", "checker", "reviewer"], { debateRounds: 1, synthesizer: "reviewer" });
        speakerTools.set("all", {
            dangerous: tool({ description: "needs approval", execute: async () => "done", inputSchema: z.object({}), needsApproval: true }),
        });
        speakerModels.set("INSTR:checker", scriptedModel([toolCallStep("dangerous", "call-1"), textStep("contra after the tool.")]));

        await runTurn();

        const row = await harness.run(async (ctx: any) => {
            const [approval] = await ctx.db.query("toolApprovalRuns").collect();

            return approval;
        });

        expect(row.config.group).toMatchObject({
            queue: [skillIds.reviewer],
            skillId: skillIds.checker,
            spokenSkillIds: [skillIds.writer, skillIds.checker],
            step: { role: "contra", round: 1, rounds: 1, skillId: skillIds.checker },
            steps: [{ role: "synthesizer", rounds: 1, skillId: skillIds.reviewer }],
        });
        expect((speakerModels.get("INSTR:reviewer") as ScriptedModel).doStreamCalls).toHaveLength(0);

        const resumeStreamId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: row.approvalId,
                    status: "pending",
                    streamingConfig: { contentType: "text", model: row.config.model },
                    threadId,
                    userId: OWNER,
                }),
        );

        await harness.action(
            async (ctx: any) =>
                await continueGroupAfterToolApproval(ctx, {
                    approvalId: row.approvalId,
                    approved: true,
                    config: row.config,
                    streamId: resumeStreamId,
                    threadId,
                    userId: OWNER,
                }),
        );

        const said = await speakersSaid();

        expect(said.at(-1)).toBe("REVIEWER");
        expect(said.filter((name) => name === "REVIEWER")).toHaveLength(1);
        expect(promptOf("reviewer").system).toContain("debated");
        expect(await statusOf(resumeStreamId)).toBe("done");
    });
});
