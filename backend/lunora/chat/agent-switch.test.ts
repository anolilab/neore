/**
 * Switching a thread's agent (plans/harness-switch.md, S1), driven against the real schema:
 * the divider row's place in the tree, the agent each path runs on, and the refusals.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { adoptForkAgentOf, pathExceedsColdStart, runAgentModelOf, syncActiveAgent } from "../agent/agent-switch";
import { agentSwitchOf } from "../agent/agent-switch-logic";
import { buildBranchTree, resolveActivePath } from "../agent/branch-tree";
import { descendFrom, getThreadRow } from "../agent/branch-rows";
import { listActivePathPage, setActiveLeafHandler } from "../agent/branches";
import { docsToModelMessages } from "../agent/mapping";
import { addMessagesHandler } from "../agent/messages";
import { omit } from "../lib/collections";
import schema from "../schema";
import { finishStoppedReply, settleStoppedRun, stopActiveForThread } from "./streaming/persistent/library";
import { AGENT_SWITCH_STREAMING, AGENT_SWITCH_UNSUPPORTED, switchThreadAgentHandler } from "./agent-switch";

type Harness = ReturnType<typeof lunoraTest>;

const NOT_ENABLED = /not an enabled chat model/;
const PRO_PLAN = /Pro plan/;

const OWNER = "owner-user";
const COLLABORATOR = "collaborator-user";
// Three text models on the free tier, so no plan lookup runs.
const A = "openai/gpt-4.1-mini";
const B = "google/gemini-2.0-flash-001";
const C = "openai/gpt-5-nano";

let harness: Harness;
let threadId: string;
const ids: Record<string, string> = {};

const run = async <T>(body: (ctx: any) => Promise<T>): Promise<T> => await harness.run(body);

const insertRow = async (name: string, order: number, stepOrder: number, message: unknown, extra: Record<string, unknown> = {}) => {
    ids[name] = await run(
        async (ctx) => await ctx.db.insert("messages", { message, order, status: "success", stepOrder, threadId, tool: false, userId: OWNER, ...extra }),
    );
};

const text = (role: "assistant" | "user", value: string) =>
    role === "user" ? { content: value, role } : { content: [{ text: value, type: "text" as const }], role };

const switchTo = async (model: string, clientId: string, userId = OWNER) =>
    await run(async (ctx) => await switchThreadAgentHandler(ctx, { clientId, target: { kind: "model", model }, threadId: threadId as never, userId }));

const insertStream = async (status: string, messageId: string) =>
    await run(
        async (ctx) =>
            await ctx.db.insert("persistentStreams", {
                expiresAt: Date.now() + 60_000,
                messageId,
                status,
                streamingConfig: { contentType: "text", model: A },
                threadId,
                userId: OWNER,
            }),
    );

// Distinct creation times, so "newest" is unambiguous.
const nextMillisecond = async () => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, 2);
    });
};

const thread = async (): Promise<any> => await run(async (ctx) => await ctx.db.get(threadId));
const activeAgentOf = async () => {
    const { activeAgent } = await thread();

    return activeAgent;
};
const rows = async (): Promise<any[]> => await run(async (ctx) => await ctx.db.query("messages").collect());
const runModel = async (extra: Record<string, unknown> = {}) => await run(async (ctx) => await runAgentModelOf(ctx, { threadId: threadId as never, ...extra }));
const switchRows = async () => {
    const all = await rows();

    return all.filter((row) => agentSwitchOf(row) !== undefined);
};

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await run(async (ctx) => await ctx.db.insert("threads", { model: A, status: "active", title: "T", userId: OWNER }));
});

afterEach(() => {
    harness.close();
});

describe("a switch in a thread that never branched", () => {
    beforeEach(async () => {
        await insertRow("u1", 0, 0, text("user", "hello"));
        await insertRow("a1", 0, 1, text("assistant", "hi"));
    });

    it("records one divider row after the last row and makes the next turn run on the new model", async () => {
        expect(await runModel()).toBeNull();

        const result = await switchTo(B, "click-1");
        const [divider] = await switchRows();

        expect(result).toMatchObject({ agent: { kind: "model", model: B }, messageId: divider._id, switched: true });
        expect(agentSwitchOf(divider)).toStrictEqual({
            from: { kind: "model", model: A },
            mode: "full",
            startMessageId: ids.a1,
            to: { kind: "model", model: B },
        });
        // A linear thread keeps its implicit parent: no explicit id, no leaf pointer.
        expect(divider).toMatchObject({ order: 1, status: "success", stepOrder: 0, tool: false });
        expect(divider.parentMessageId).toBeUndefined();
        const { activeLeafMessageId } = await thread();

        expect(activeLeafMessageId).toBeUndefined();
        // The creation model is the fallback of every path without a switch, so it stays.
        expect(await thread()).toMatchObject({ activeAgent: { kind: "model", model: B }, model: A });
        expect(await runModel()).toBe(B);
    });

    it("keeps the divider out of what the model reads, and the conversation carries on after it", async () => {
        await switchTo(B, "click-1");
        await run(async (ctx) => {
            await addMessagesHandler(ctx, {
                fromUser: true,
                messages: [{ message: text("user", "next"), status: "success" }],
                threadId: threadId as never,
                userId: OWNER,
            });
        });

        const all = await rows();
        const ordered = all.toSorted((a, b) => a.order - b.order || a.stepOrder - b.stepOrder);

        expect(ordered.map((row) => row.order)).toStrictEqual([0, 0, 1, 2]);
        expect(docsToModelMessages(ordered).map((message) => message.role)).toStrictEqual(["user", "assistant", "user"]);
        expect(await runModel()).toBe(B);
    });

    it("answers a repeated clientId once, even when a later switch has moved on", async () => {
        await switchTo(B, "click-1");
        await switchTo(C, "click-2");

        // A stale tap of the first click arrives after the second switch.
        const replay = await switchTo(B, "click-1");

        expect(replay).toMatchObject({ agent: { kind: "model", model: C }, messageId: null, switched: false });
        expect(await switchRows()).toHaveLength(2);
        expect(await runModel()).toBe(C);
    });

    it("claims the clientId of a pick that changed nothing, so its replay cannot undo a later switch", async () => {
        expect(await switchTo(A, "click-1")).toMatchObject({ switched: false });

        await switchTo(B, "click-2");

        const replay = await switchTo(A, "click-1");

        expect(replay).toMatchObject({ agent: { kind: "model", model: B }, messageId: null, switched: false });
        expect(await switchRows()).toHaveLength(1);
        expect(await runModel()).toBe(B);
    });

    it("writes nothing when the thread is already on the target", async () => {
        expect(await switchTo(A, "click-1")).toMatchObject({ messageId: null, switched: false });
        expect(await switchRows()).toHaveLength(0);
        const { activeAgent } = await thread();

        expect(activeAgent).toBeUndefined();
    });

    it("is refused while a reply streams, and works again once it finished", async () => {
        const streamId = await run(
            async (ctx) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: ids.u1,
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: A },
                    threadId,
                    userId: OWNER,
                }),
        );

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });
        expect(await switchRows()).toHaveLength(0);

        await run(async (ctx) => await ctx.db.patch(streamId, { status: "done" }));

        expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });
    });

    it("is refused while an edit's reply streams through the delta stream, and works again once it finished", async () => {
        const streamId = await run(
            async (ctx) =>
                await ctx.db.insert("streamingMessages", {
                    order: 1,
                    state: { kind: "streaming", lastHeartbeat: Date.now() },
                    stateKind: "streaming",
                    stepOrder: 0,
                    threadId,
                    userId: OWNER,
                }),
        );

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });
        expect(await switchRows()).toHaveLength(0);

        await run(async (ctx) => await ctx.db.patch(streamId, { state: { endedAt: Date.now(), kind: "finished" }, stateKind: "finished" }));

        expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });
    });

    it("is refused while an older run streams, however many newer runs have finished since", async () => {
        await insertStream("streaming", ids.u1 as string);

        for (let index = 0; index < 6; index += 1) {
            await nextMillisecond();
            await insertStream("done", ids.a1 as string);
        }

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });
        expect(await switchRows()).toHaveLength(0);
    });

    it("refuses a host target here with a typed error (it is routed to the coding-agent switch), and a model that is not an enabled chat model", async () => {
        await expect(
            run(
                async (ctx) =>
                    await switchThreadAgentHandler(ctx, {
                        clientId: "c",
                        target: { agentKey: "claude", folderId: "f1", hostId: "device" as never, kind: "host" },
                        threadId: threadId as never,
                        userId: OWNER,
                    }),
            ),
        ).rejects.toMatchObject({ data: { code: AGENT_SWITCH_UNSUPPORTED } });
        await expect(switchTo("no/such-model", "c2")).rejects.toThrow(NOT_ENABLED);
        await expect(switchTo("openai/gpt-image-1", "c3")).rejects.toThrow(NOT_ENABLED);
        // Listed in the catalog but with no API behind it: refused, or a reply would silently run on another model.
        await expect(switchTo("ext/mimo-v2-flash", "c4")).rejects.toThrow(NOT_ENABLED);
        expect(await switchRows()).toHaveLength(0);
    });

    it("refuses a paid model for a caller whose plan does not run it, before writing", async () => {
        const noPlan = async (ctx: any) =>
            await switchThreadAgentHandler(
                new Proxy(ctx, {
                    get: (target, property) =>
                        property === "runQuery"
                            ? async () => {
                                  return { isAdmin: false, plan: null };
                              }
                            : target[property],
                }),
                { clientId: "c", target: { kind: "model", model: "anthropic/claude-opus-4.1" }, threadId: threadId as never, userId: OWNER },
            );

        await expect(run(noPlan)).rejects.toThrow(PRO_PLAN);
        expect(await switchRows()).toHaveLength(0);
    });

    it("is refused while the latest turn waits on an approval, and once the request is stale", async () => {
        const approval = {
            content: [
                { input: {}, toolCallId: "call-1", toolName: "mcp_Files__delete", type: "tool-call" },
                { approvalId: "approval-1", toolCallId: "call-1", type: "tool-approval-request" },
            ],
            role: "assistant",
        };

        await run(async (ctx) => await ctx.db.delete(ids.a1));
        await insertRow("paused", 0, 1, approval, { tool: true });
        await run(
            async (ctx) =>
                await ctx.db.insert("toolApprovalRuns", {
                    approvalId: "approval-1",
                    config: {
                        autoMediaEnrichment: false,
                        instructions: "",
                        mcpServerNames: [],
                        model: A,
                        researchDepth: "balanced",
                        searchMode: "chat",
                        shouldAutoContinue: false,
                        toolNames: [],
                    },
                    createdAt: Date.now(),
                    status: "pending",
                    threadId,
                    userId: OWNER,
                }),
        );

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });
        expect(await switchRows()).toHaveLength(0);

        // The user carried on without answering: the request is stale.
        await insertRow("u2", 1, 0, text("user", "never mind"));
        await insertRow("a2", 1, 1, text("assistant", "ok"));

        expect(await switchTo(B, "click-2")).toMatchObject({ switched: true });
    });

    it("refuses a paid model the thread's owner cannot run when a collaborator picks it, before writing", async () => {
        await run(async (ctx) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR }));

        // The collaborator is on a paid plan; the owner is not.
        const asCollaborator = async (ctx: any) =>
            await switchThreadAgentHandler(
                new Proxy(ctx, {
                    get: (target, property) =>
                        property === "runQuery"
                            ? async (_reference: unknown, queryArgs: { userId: string }) => {
                                  const premium = queryArgs.userId === COLLABORATOR;

                                  return { isAdmin: false, plan: premium ? "premium" : null };
                              }
                            : target[property],
                }),
                { clientId: "c", target: { kind: "model", model: "anthropic/claude-opus-4.1" }, threadId: threadId as never, userId: COLLABORATOR },
            );

        await expect(run(asCollaborator)).rejects.toThrow(PRO_PLAN);
        expect(await switchRows()).toHaveLength(0);
    });

    it("is refused for a guest", async () => {
        const guestId = await run(
            async (ctx) =>
                await ctx.db.insert("user", { createdAt: 1, email: "guest@example.com", emailVerified: false, isAnonymous: true, name: "Guest", updatedAt: 1 }),
        );

        await run(async (ctx) => await ctx.db.patch(threadId, { userId: guestId }));
        await insertRow("u1", 0, 0, text("user", "hello"), { userId: guestId });

        await expect(switchTo(B, "c", guestId)).rejects.toMatchObject({ data: { code: AGENT_SWITCH_UNSUPPORTED } });
    });

    it("refuses a thread that runs on a fixed agent", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { groupChat: { mode: "round-robin", participants: [] } }));

        await expect(switchTo(B, "c")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_UNSUPPORTED } });
    });

    it("refuses a coding-agent thread, whose turns run on its host", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { runner: "host" }));

        await expect(switchTo(B, "c")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_UNSUPPORTED } });
        expect(await switchRows()).toHaveLength(0);
    });

    it("refuses a messenger thread, which replies on its connection's model", async () => {
        const connectionId = await run(async (ctx) => await ctx.db.insert("messengerConnections", { platform: "telegram", userId: OWNER } as never));

        await run(async (ctx) => await ctx.db.patch(threadId, { messengerConnectionId: connectionId }));

        await expect(switchTo(B, "c")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_UNSUPPORTED } });
        expect(await switchRows()).toHaveLength(0);
    });

    it("is refused while the path ends on a prompt no reply answers yet, and works once the reply exists", async () => {
        // The prompt is saved before its stream is created: a divider now would sit under the prompt the reply hangs off.
        await insertRow("u2", 1, 0, text("user", "and now?"));

        await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });
        expect(await switchRows()).toHaveLength(0);

        await insertRow("a2", 1, 1, text("assistant", "this"));

        expect(await switchTo(B, "click-2")).toMatchObject({ switched: true });
    });

    it("works on a prompt whose run was stopped before the first token, so the user can leave a model that is not answering", async () => {
        await insertRow("u2", 1, 0, text("user", "and now?"));
        await run(
            async (ctx) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: ids.u2,
                    status: "aborted",
                    streamingConfig: { contentType: "text", model: A },
                    threadId,
                    userId: OWNER,
                }),
        );

        expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });
    });

    it("finds the run of a prompt among more than the newest few streams of the thread", async () => {
        await insertRow("u2", 1, 0, text("user", "and now?"));

        await insertStream("aborted", ids.u2 as string);

        for (let index = 0; index < 6; index += 1) {
            await nextMillisecond();
            await insertStream("done", ids.u1 as string);
        }

        expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });
    });

    describe("after a sidebar stop", () => {
        const startStoppedRun = async ({ claimed = true, expiresAt = Date.now() + 60_000 } = {}) => {
            await insertRow("u2", 1, 0, text("user", "and now?"));
            const streamId = await run(
                async (ctx) =>
                    await ctx.db.insert("persistentStreams", {
                        expiresAt,
                        messageId: ids.u2,
                        ...(claimed && { runClaimedAt: Date.now() }),
                        status: claimed ? "streaming" : "pending",
                        streamingConfig: { contentType: "text", model: A },
                        threadId,
                        userId: OWNER,
                    }),
            );

            await run(async (ctx) => await ctx.runMutation(stopActiveForThread, { threadId }));

            return streamId;
        };

        it("is refused until the run has saved the text it owed, then works", async () => {
            // The stop ended the stream (`done`) but the reply is not in the thread yet: a divider now would sit under the prompt the reply then hangs off.
            const streamId = await startStoppedRun();

            await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });
            expect(await switchRows()).toHaveLength(0);

            const { stopped } = await run(
                async (ctx) =>
                    await ctx.runMutation(finishStoppedReply, {
                        continuation: false,
                        order: 1,
                        pendingReasoning: "",
                        pendingText: "partial",
                        promptMessageId: ids.u2,
                        streamId,
                    }),
            );

            expect(stopped).toBe(true);
            expect(await switchTo(B, "click-2")).toMatchObject({ switched: true });
        });

        it("stops blocking once the run that failed has settled its stop", async () => {
            const streamId = await startStoppedRun();

            await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });

            await run(async (ctx) => await ctx.runMutation(settleStoppedRun, { streamId }));

            expect(await switchTo(B, "click-2")).toMatchObject({ switched: true });
        });

        it("stops blocking when the run died without a trace, a couple of minutes after the stop", async () => {
            const streamId = await startStoppedRun({ expiresAt: Date.now() + 20 * 60_000 });

            await expect(switchTo(B, "click-1")).rejects.toMatchObject({ data: { code: AGENT_SWITCH_STREAMING } });

            await run(async (ctx) => await ctx.db.patch(streamId, { stoppedAt: Date.now() - 3 * 60_000 }));

            expect(await switchTo(B, "click-2")).toMatchObject({ switched: true });
        });

        it("works at once when the run had not started, since nothing will ever save a reply", async () => {
            await startStoppedRun({ claimed: false });

            expect(await switchTo(B, "click-1")).toMatchObject({ switched: true });
        });
    });

    it("needs a write grant: a reader is refused, a writer switches, and the row carries the writer", async () => {
        await run(async (ctx) => await ctx.db.insert("threadAccess", { grantedAt: 0, grantedBy: OWNER, permission: "read", threadId, userId: COLLABORATOR }));
        await expect(switchTo(B, "c1", COLLABORATOR)).rejects.toMatchObject({ code: "NOT_FOUND" });

        await run(async (ctx) => {
            const grant = await ctx.db.threadAccess.findFirst({ where: { threadId, userId: COLLABORATOR } });

            await ctx.db.patch(grant._id, { permission: "write" });
        });

        expect(await switchTo(B, "c2", COLLABORATOR)).toMatchObject({ switched: true });
        const [written] = await switchRows();

        expect(written).toMatchObject({ userId: COLLABORATOR });
    });

    it("refuses a stranger as it refuses a missing thread", async () => {
        await expect(switchTo(B, "c", "stranger")).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
});

describe("the agent of each branch", () => {
    // u1 → { a1 → u2 → a2 , a1b }: a1b is a regenerate of a1, and the conversation carried on from a1
    // (u2 names its parent, as `pinFollowingRowParent` does when a regenerate lands before it).
    beforeEach(async () => {
        await insertRow("u1", 0, 0, text("user", "hello"));
        await insertRow("a1", 0, 1, text("assistant", "hi"));
        await insertRow("u2", 1, 0, text("user", "more"), { parentMessageId: ids.a1 });
        await insertRow("a2", 1, 1, text("assistant", "sure"));
        await insertRow("a1b", 0, 2, text("assistant", "hey"), { parentMessageId: ids.u1 });
    });

    const pointAt = async (name: string) => {
        // The switcher: the leaf reached from the clicked message, then the cache follows it.
        await run(async (ctx) => {
            const leaf = await descendFrom(ctx, threadId as never, (await getThreadRow(ctx, threadId as never, ids[name]!))!);

            await ctx.db.patch(threadId, { activeLeafMessageId: leaf._id });
            await syncActiveAgent(ctx, threadId as never, leaf._id);
        });
    };

    it("places the divider under the displayed leaf, past every order, without touching the other branch", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.a1b }));

        const result = await switchTo(B, "click-1");
        const all = await rows();
        const divider = all.find((row) => row._id === result.messageId);
        const tree = buildBranchTree(all);

        // a2 holds order 1, so the divider takes 2 — an order the sibling branch never reuses.
        expect(divider).toMatchObject({ order: 2, parentMessageId: ids.a1b });
        const { activeLeafMessageId } = await thread();

        expect(activeLeafMessageId).toBe(divider._id);
        expect(resolveActivePath(tree, divider._id)).toStrictEqual([ids.u1, ids.a1b, divider._id]);
        expect(resolveActivePath(tree, ids.a2)).toStrictEqual([ids.u1, ids.a1, ids.u2, ids.a2]);
    });

    it("restores each branch's agent when the user moves between them", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.a2 }));
        await switchTo(B, "click-1");

        expect(await runModel()).toBe(B);

        await pointAt("a1b");
        expect(await runModel()).toBe(A);
        expect(await activeAgentOf()).toStrictEqual({ kind: "model", model: A });

        await pointAt("a1");
        expect(await runModel()).toBe(B);
        expect(await activeAgentOf()).toStrictEqual({ kind: "model", model: B });

        // A second switch on the other branch is its own: the first branch keeps B.
        await pointAt("a1b");
        await switchTo(C, "click-2");
        expect(await runModel()).toBe(C);
        await pointAt("a1");
        expect(await runModel()).toBe(B);
    });

    it("runs a regenerate or an edit of an older message on the model recorded on its path", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.a2 }));
        await switchTo(B, "click-1");
        await run(async (ctx) => {
            await addMessagesHandler(ctx, {
                fromUser: true,
                messages: [{ message: text("user", "later"), status: "success" }],
                threadId: threadId as never,
                userId: OWNER,
            });
        });
        const all = await rows();
        const u3 = all.find((row) => row.message?.content === "later");

        // The composer would show B by now; the older prompts still belong to A, the later one to B.
        expect(await runModel()).toBe(B);
        expect(await runModel({ promptMessageId: ids.u1 })).toBe(A);
        expect(await runModel({ promptMessageId: ids.u2 })).toBe(A);
        expect(await runModel({ promptMessageId: u3._id })).toBe(B);
        expect(await runModel({ replacedMessageId: ids.u2 })).toBe(A);
        expect(await runModel({ replacedMessageId: u3._id })).toBe(B);
    });

    it("runs a regenerate of the latest turn on the agent picked after its reply, an earlier turn on its own path", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.a2 }));
        await switchTo(B, "click-1");

        // The divider hangs under a2, off the path through u2; u2 is still the newest turn.
        expect(await runModel({ promptMessageId: ids.u2 })).toBe(B);
        expect(await runModel({ promptMessageId: ids.u1 })).toBe(A);
    });

    it("keeps the cache in step when a regenerate points the thread at an older prompt", async () => {
        await run(async (ctx) => await ctx.db.patch(threadId, { activeLeafMessageId: ids.a2 }));
        await switchTo(B, "click-1");

        // `setActiveLeaf` points AT the prompt without descending: a switch below it is not on its path.
        await run(async (ctx) => {
            await ctx.db.patch(threadId, { activeLeafMessageId: ids.u2 });
            await syncActiveAgent(ctx, threadId as never, ids.u2!);
        });

        const { activeAgent } = await thread();

        expect(activeAgent).toStrictEqual({ kind: "model", model: A });
    });
});

describe("a regenerate of the newest turn after a switch", () => {
    beforeEach(async () => {
        await insertRow("u1", 0, 0, text("user", "hello"));
        await insertRow("a1", 0, 1, text("assistant", "hi"));
        await switchTo(B, "click-1");
    });

    // What `/chat/start` does for a regenerate: point the thread at the prompt, then the run saves its pending reply.
    const regenerate = async (promptId: string, runModelId: string) => {
        await run(async (ctx) => await setActiveLeafHandler(ctx, { messageId: promptId as never, runModel: runModelId, threadId: threadId as never }));
        await run(async (ctx) => {
            await addMessagesHandler(ctx, {
                failPendingSteps: true,
                messages: [{ message: { content: [], role: "assistant" }, status: "pending" }],
                promptMessageId: promptId as never,
                threadId: threadId as never,
                userId: OWNER,
            });
        });
    };
    const pathNames = async (): Promise<string[]> => {
        const { activeLeafMessageId } = await thread();
        const all = await rows();
        const names = new Map(Object.entries(ids).map(([name, id]) => [id, name]));

        return resolveActivePath(buildBranchTree(all), activeLeafMessageId).map(
            (id) => names.get(id) ?? (agentSwitchOf(all.find((row) => row._id === id)) ? "divider" : "reply"),
        );
    };

    it("keeps the switched agent on the regenerated branch, so the next send runs on it", async () => {
        await regenerate(ids.u1!, B);

        expect(await pathNames()).toStrictEqual(["u1", "divider", "reply"]);
        expect(await activeAgentOf()).toStrictEqual({ kind: "model", model: B });
        expect(await runModel()).toBe(B);

        // The divider is under the prompt and names the switch the redo ran on; the earlier one is untouched.
        const dividers = await switchRows();
        const [first, second] = dividers.toSorted((x, y) => x.order - y.order || x.stepOrder - y.stepOrder);

        expect(agentSwitchOf(first)).toMatchObject({ from: { model: A }, startMessageId: ids.u1, to: { model: B } });
        expect(first).toMatchObject({ order: 0, parentMessageId: ids.u1 });
        expect(agentSwitchOf(second)).toMatchObject({ startMessageId: ids.a1, to: { model: B } });

        // The original reply keeps its own place: the first divider still follows it.
        const tree = buildBranchTree(await rows());

        expect(tree.parentOf(second._id)).toBe(ids.a1);

        // A prompt sent next runs on B and the thread stays there.
        await run(async (ctx) => {
            await addMessagesHandler(ctx, {
                fromUser: true,
                messages: [{ message: text("user", "next"), status: "success" }],
                threadId: threadId as never,
                userId: OWNER,
            });
        });
        expect(await runModel()).toBe(B);
        expect(await activeAgentOf()).toStrictEqual({ kind: "model", model: B });
    });

    it("reuses the divider when the same turn is regenerated again", async () => {
        await regenerate(ids.u1!, B);
        await regenerate(ids.u1!, B);

        expect(await switchRows()).toHaveLength(2);
        expect(await pathNames()).toStrictEqual(["u1", "divider", "reply"]);
        expect(await runModel()).toBe(B);
    });

    it("stays on the switched agent when the run is stopped or fails before it saved a reply", async () => {
        await run(async (ctx) => await setActiveLeafHandler(ctx, { messageId: ids.u1 as never, runModel: B, threadId: threadId as never }));

        expect(await pathNames()).toStrictEqual(["u1", "divider"]);
        expect(await activeAgentOf()).toStrictEqual({ kind: "model", model: B });
        expect(await runModel()).toBe(B);
    });

    it("writes no divider when the run does not use the path's agent", async () => {
        // A bot or a model outside the registry keeps what it brought; the path is left as it was.
        await regenerate(ids.u1!, A);

        expect(await switchRows()).toHaveLength(1);
        expect(await pathNames()).toStrictEqual(["u1", "reply"]);
    });

    it("writes no divider for an older turn, which runs on its own path", async () => {
        await insertRow("u2", 2, 0, text("user", "more"));
        await insertRow("a2", 2, 1, text("assistant", "sure"));
        await regenerate(ids.u1!, A);

        expect(await switchRows()).toHaveLength(1);
        expect(await activeAgentOf()).toStrictEqual({ kind: "model", model: A });
    });

    it("offers the original reply and the regenerated one as siblings in the switcher", async () => {
        await regenerate(ids.u1!, B);

        const stored = await thread();
        const page: any = await run(async (ctx) => await listActivePathPage(ctx, stored, { cursor: null, numItems: 100 }));
        const reply = page.page.find((row: any) => row.status === "pending");
        const divider = page.page.find((row: any) => agentSwitchOf(row));

        expect(page.branches.get(reply._id)).toMatchObject({ count: 2, index: 1, siblingIds: [ids.a1, reply._id] });
        expect(page.branches.has(divider._id)).toBe(false);
    });
});

describe("a regenerate of a prompt that was stopped before its reply, after a switch and a later send", () => {
    it("offers no later prompt as a version of the regenerated reply", async () => {
        await insertRow("u1", 0, 0, text("user", "hello"));
        await insertStream("aborted", ids.u1!);
        await switchTo(B, "click-1");
        await run(async (ctx) => {
            await addMessagesHandler(ctx, {
                fromUser: true,
                messages: [{ message: text("user", "next"), status: "success" }],
                threadId: threadId as never,
                userId: OWNER,
            });
        });
        await run(async (ctx) => await setActiveLeafHandler(ctx, { messageId: ids.u1 as never, runModel: B, threadId: threadId as never }));
        await run(async (ctx) => {
            await addMessagesHandler(ctx, {
                failPendingSteps: true,
                messages: [{ message: { content: [], role: "assistant" }, status: "pending" }],
                promptMessageId: ids.u1 as never,
                threadId: threadId as never,
                userId: OWNER,
            });
        });

        const stored = await thread();
        const page: any = await run(async (ctx) => await listActivePathPage(ctx, stored, { cursor: null, numItems: 100 }));
        const reply = page.page.find((row: any) => row.status === "pending");
        const all = await rows();
        const prompts = new Set(all.filter((row) => row.message?.role === "user").map((row) => row._id));

        expect(reply).toBeDefined();
        expect(page.branches.get(reply._id)?.siblingIds.some((id: string) => prompts.has(id)) ?? false).toBe(false);
    });
});

describe("a fork of a switched thread", () => {
    const forkWith = async (rowsToCopy: any[]): Promise<string> =>
        await run(async (ctx) => {
            const forkId = await ctx.db.insert("threads", { model: A, status: "active", title: "fork", userId: OWNER });

            for (const row of rowsToCopy) {
                await ctx.db.insert("messages", { ...omit(row, ["_creationTime", "_id", "threadId"]), threadId: forkId });
            }

            await adoptForkAgentOf(ctx, forkId);

            return forkId;
        });

    it("runs on the agent its copied divider names, and keeps the model of a fork cut before it", async () => {
        await insertRow("u1", 0, 0, text("user", "hello"));
        await insertRow("a1", 0, 1, text("assistant", "hi"));
        await switchTo(B, "click-1");

        const stored = await rows();
        const all = stored.toSorted((x, y) => x.order - y.order || x.stepOrder - y.stepOrder);
        const switched = await forkWith(all);
        const before = await forkWith(all.slice(0, 2));
        const agentOf = async (id: string) => await run(async (ctx) => await runAgentModelOf(ctx, { threadId: id as never }));

        expect(await agentOf(switched)).toBe(B);
        expect(await agentOf(before)).toBeNull();
    });

    it("points a copied divider at the row before it in the fork, not at a row of the source", async () => {
        await insertRow("u1", 0, 0, text("user", "hello"));
        await insertRow("a1", 0, 1, text("assistant", "hi"));
        await switchTo(B, "click-1");
        await insertRow("u2", 2, 0, text("user", "more"));
        await insertRow("a2", 2, 1, text("assistant", "sure"));
        await switchTo(C, "click-2");

        const source = await rows();
        const all = source.toSorted((x, y) => x.order - y.order || x.stepOrder - y.stepOrder);
        const forkId = await forkWith(all);
        const stored = await rows();
        const ordered = stored.filter((row) => row.threadId === forkId).toSorted((x, y) => x.order - y.order || x.stepOrder - y.stepOrder);
        const dividers = ordered.flatMap((row, index) => {
            const part = agentSwitchOf(row);

            return part ? [{ before: ordered[index - 1], part }] : [];
        });

        expect(dividers).toHaveLength(2);

        for (const { before, part } of dividers) {
            expect(part.startMessageId).toBe(before._id);
        }
    });
});

describe("the cost notice", () => {
    // The shared threshold is 20,000 tokens at 4 characters each.
    const longRow = async (name: string, order: number, stepOrder: number, role: "assistant" | "user", characters: number) =>
        await insertRow(name, order, stepOrder, text(role, "x"), { text: "x".repeat(characters) });

    it("is on for a switch above the threshold and off for one below it", async () => {
        await longRow("u1", 0, 0, "user", 40_000);
        await longRow("a1", 0, 1, "assistant", 39_996);

        expect(await switchTo(B, "click-1")).toMatchObject({ coldStartCostly: false, switched: true });

        await longRow("u2", 2, 0, "user", 8);
        await longRow("a2", 2, 1, "assistant", 0);

        expect(await switchTo(C, "click-2")).toMatchObject({ coldStartCostly: true, switched: true });
    });

    it("is off when nothing was switched", async () => {
        await longRow("u1", 0, 0, "user", 400_000);

        expect(await switchTo(A, "click-1")).toMatchObject({ coldStartCostly: false, switched: false });
    });

    it("stops counting at the first row of a path that has none", async () => {
        expect(await run(async (ctx) => await pathExceedsColdStart(ctx, threadId as never, null))).toBe(false);
    });
});
