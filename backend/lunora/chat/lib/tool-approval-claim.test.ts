/**
 * `respondToToolApproval`'s authorisation and state transition, driven against
 * the real schema: who may answer, what counts as still pending, and that a
 * second answer never claims the run twice.
 */
import { lunoraTest } from "@lunora/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { loadHomeOverview } from "../../home/overview";
import schema from "../../schema";
import { recordPendingToolApprovals } from "../tool-permissions";
import { claimToolApproval, collectApprovalRequestIds } from "./tool-approval-claim";
import { PENDING_APPROVAL_TTL_MS } from "./tool-approval-cleanup";

type Harness = ReturnType<typeof lunoraTest>;

const OWNER = "owner-user";
const STRANGER = "other-user";
const COLLABORATOR = "collab-user";
const APPROVAL_ID = "approval-1";

const CONFIG = {
    autoMediaEnrichment: false,
    instructions: "system prompt",
    mcpServerNames: ["Files"],
    model: "test-model",
    researchDepth: "balanced" as const,
    searchMode: "chat",
    shouldAutoContinue: false,
    toolNames: ["mcp_Files__delete", "datetime"],
};

const assistantWithRequest = (approvalId: string) => {
    return {
        content: [
            { input: {}, toolCallId: `call-${approvalId}`, toolName: "mcp_Files__delete", type: "tool-call" },
            { approvalId, toolCallId: `call-${approvalId}`, type: "tool-approval-request" },
        ],
        role: "assistant",
    };
};

let harness: Harness;
let threadId: string;

const insertMessage = async (order: number, message: unknown, tool = false) =>
    await harness.run(async (ctx: any) => await ctx.db.insert("messages", { message, order, status: "success", stepOrder: 0, threadId, tool, userId: OWNER }));

const claim = async (callerId: string, decision: "always" | "approve" | "deny" = "approve", approvalId = APPROVAL_ID) =>
    await harness.run(async (ctx: any) => await claimToolApproval(ctx, { approvalId, callerId, decision, threadId: threadId as never }));

const runStatus = async () =>
    await harness.run(async (ctx: any) => {
        const rows = await ctx.db.query("toolApprovalRuns").collect();

        return rows.map((r: { status: string }) => r.status);
    });

beforeEach(async () => {
    harness = lunoraTest(schema as never);
    threadId = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "T", userId: OWNER }));

    await insertMessage(0, { content: "delete my file", role: "user" });
    await insertMessage(1, assistantWithRequest(APPROVAL_ID), true);
    await harness.run(
        async (ctx: any) =>
            await ctx.db.insert("toolApprovalRuns", {
                approvalId: APPROVAL_ID,
                config: CONFIG,
                createdAt: Date.now(),
                status: "pending",
                threadId,
                userId: OWNER,
            }),
    );
});

afterEach(() => {
    harness.close();
});

describe("claimToolApproval", () => {
    it("claims a pending request for the owner and returns the snapshot", async () => {
        const result = await claim(OWNER);

        expect(result).toMatchObject({ config: CONFIG, kind: "claimed", ownerId: OWNER, toolName: "mcp_Files__delete" });
        expect(await runStatus()).toStrictEqual(["approved"]);
    });

    it("answering the last open approval takes the thread out of waiting for the owner", async () => {
        await harness.run(async (ctx: any) => await ctx.db.patch("threads", threadId as never, { awaitingInput: "approval" }));

        await claim(OWNER);

        const thread = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId as never));

        expect(thread?.awaitingInput).toBeUndefined();
    });

    it("answering one of two open approvals keeps the thread waiting for the other", async () => {
        await harness.run(async (ctx: any) => {
            await ctx.db.patch("threads", threadId as never, { awaitingInput: "approval" });
            await ctx.db.insert("toolApprovalRuns", {
                approvalId: "approval-2",
                config: CONFIG,
                createdAt: Date.now(),
                status: "pending",
                threadId,
                userId: OWNER,
            });
        });

        await claim(OWNER);

        const thread = await harness.run(async (ctx: any) => await ctx.db.get("threads", threadId as never));

        expect(thread?.awaitingInput).toBe("approval");
    });

    it("records a denial as denied", async () => {
        await claim(OWNER, "deny");

        expect(await runStatus()).toStrictEqual(["denied"]);
    });

    it("rejects another user and leaves the run pending", async () => {
        await expect(claim(STRANGER)).rejects.toThrow("Thread not found");
        expect(await runStatus()).toStrictEqual(["pending"]);
    });

    it("rejects a read-only collaborator", async () => {
        await harness.run(
            async (ctx: any) => await ctx.db.insert("threadAccess", { grantedAt: 1, grantedBy: OWNER, permission: "read", threadId, userId: COLLABORATOR }),
        );

        await expect(claim(COLLABORATOR)).rejects.toThrow("Thread not found");
    });

    // The tool runs with the owner's MCP servers and keys, so write access to
    // the chat is not enough to trigger it — in any of the three decisions.
    it.each(["approve", "deny", "always"] as const)("refuses a write collaborator's %s and leaves the run pending", async (decision) => {
        await harness.run(
            async (ctx: any) => await ctx.db.insert("threadAccess", { grantedAt: 1, grantedBy: OWNER, permission: "write", threadId, userId: COLLABORATOR }),
        );

        await expect(claim(COLLABORATOR, decision)).rejects.toThrow("Only the thread owner");
        expect(await runStatus()).toStrictEqual(["pending"]);
    });

    it("refuses an admin collaborator too", async () => {
        await harness.run(
            async (ctx: any) => await ctx.db.insert("threadAccess", { grantedAt: 1, grantedBy: OWNER, permission: "admin", threadId, userId: COLLABORATOR }),
        );

        await expect(claim(COLLABORATOR)).rejects.toThrow("Only the thread owner");
    });

    it("is idempotent: a double submit claims once and reports the first outcome", async () => {
        const first = await claim(OWNER);

        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("toolApprovalRuns").collect();

            await ctx.db.patch("toolApprovalRuns", row._id, { streamId: "stream-1" });
        });

        const second = await claim(OWNER, "deny");

        expect(first.kind).toBe("claimed");
        expect(second).toStrictEqual({ kind: "already-resolved", status: "approved", streamId: "stream-1" });
        expect(await runStatus()).toStrictEqual(["approved"]);
    });

    it("reports an already-resolved id without re-claiming it", async () => {
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("toolApprovalRuns").collect();

            await ctx.db.patch("toolApprovalRuns", row._id, { status: "denied" });
        });

        expect(await claim(OWNER)).toStrictEqual({ kind: "already-resolved", status: "denied", streamId: null });
    });

    it("refuses a snapshot past its retention even before the sweep removes it", async () => {
        await harness.run(async (ctx: any) => {
            const [row] = await ctx.db.query("toolApprovalRuns").collect();

            await ctx.db.patch("toolApprovalRuns", row._id, { createdAt: Date.now() - PENDING_APPROVAL_TTL_MS - 1 });
        });

        await expect(claim(OWNER)).rejects.toThrow("can no longer be resumed");
    });

    it("fails closed when no snapshot exists for the approval id", async () => {
        await insertMessage(2, assistantWithRequest("approval-2"), true);

        await expect(claim(OWNER, "approve", "approval-2")).rejects.toThrow("can no longer be resumed");
    });

    it("refuses a request that is no longer on the latest turn", async () => {
        await insertMessage(2, { content: "never mind", role: "user" });

        await expect(claim(OWNER)).rejects.toThrow("no longer pending");
        expect(await runStatus()).toStrictEqual(["pending"]);
    });

    it("refuses a request a tool message already answered", async () => {
        await insertMessage(2, { content: [{ approvalId: APPROVAL_ID, approved: true, type: "tool-approval-response" }], role: "tool" }, true);

        await expect(claim(OWNER)).rejects.toThrow("no longer pending");
    });

    it("refuses a snapshot that belongs to a different thread", async () => {
        const otherThread = await harness.run(async (ctx: any) => await ctx.db.insert("threads", { title: "Other", userId: OWNER }));

        await expect(
            harness.run(
                async (ctx: any) => await claimToolApproval(ctx, { approvalId: APPROVAL_ID, callerId: OWNER, decision: "approve", threadId: otherThread }),
            ),
        ).rejects.toThrow("can no longer be resumed");
    });
});

describe("collectApprovalRequestIds", () => {
    it("reads approval ids from assistant messages only", () => {
        expect(
            collectApprovalRequestIds([
                { message: { content: "hi", role: "user" } },
                { message: assistantWithRequest("a") },
                { message: { content: [{ approvalId: "b", type: "tool-approval-response" }], role: "tool" } },
                { message: assistantWithRequest("c") },
            ]),
        ).toStrictEqual(["a", "c"]);
    });

    it("tolerates missing input", () => {
        expect(collectApprovalRequestIds(undefined)).toStrictEqual([]);
    });
});

describe("a collaborator's paused turn", () => {
    it("is recorded for the thread owner: on their home, and answerable by them", async () => {
        await insertMessage(2, { content: "tidy up", role: "user" });
        await insertMessage(3, assistantWithRequest("approval-2"), true);
        await harness.run(
            async (ctx: any) =>
                await ctx.runMutation(recordPendingToolApprovals, { approvalIds: ["approval-2"], config: CONFIG, threadId, userId: COLLABORATOR }),
        );

        const home = await harness.run(async (ctx: any) => await loadHomeOverview(ctx, OWNER));

        expect(home.approvals.map((approval: { approvalId: string }) => approval.approvalId)).toContain("approval-2");
        await expect(claim(OWNER, "approve", "approval-2")).resolves.toMatchObject({ kind: "claimed", ownerId: OWNER });
    });
});

describe("what a pause notifies as", () => {
    const notifications = async () => await harness.run(async (ctx: any) => await ctx.db.query("notifications").collect());

    it("is a tool approval for an ordinary call, a question for askUser and its own type for a secret request", async () => {
        const record = async (approvalIds: string[], extra: { askUserApprovalIds?: string[]; secretApprovalIds?: string[] }) =>
            await harness.run(
                async (ctx: any) => await ctx.runMutation(recordPendingToolApprovals, { approvalIds, config: CONFIG, threadId, userId: OWNER, ...extra }),
            );

        await record(["plain-1"], {});
        await record(["ask-1"], { askUserApprovalIds: ["ask-1"] });
        await record(["secret-1", "plain-2"], { secretApprovalIds: ["secret-1"] });

        const rows = (await notifications()) as { dedupeKey: string; type: string }[];

        expect(rows.map((row) => row.type).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["ask_user", "secret_request", "tool_approval"]);
        expect(rows.find((row) => row.type === "secret_request")?.dedupeKey).toBe("secret_request:secret-1");
    });

    it("words the push for a secret request, and sends it urgently like the other things a run waits on", async () => {
        const { pushTitle, pushUrgency } = await import("../../notifications/push-text");

        expect(pushTitle("secret_request", undefined)).toBe("The assistant is asking for a secret");
        expect(pushUrgency("secret_request")).toBe("high");
    });
});

describe("a run a resume replaced between its epoch check and its write", () => {
    it("records no approval and notifies no one: the epoch is checked inside the writing mutation", async () => {
        const streamId = await harness.run(
            async (ctx: any) =>
                await ctx.db.insert("persistentStreams", {
                    expiresAt: Date.now() + 60_000,
                    messageId: "m",
                    runClaimedAt: 1,
                    runEpoch: 1,
                    status: "streaming",
                    streamingConfig: { contentType: "text", model: "test-model" },
                    threadId,
                    userId: OWNER,
                }),
        );
        const record = async (epoch: number) =>
            await harness.run(
                async (ctx: any) =>
                    await ctx.runMutation(recordPendingToolApprovals, {
                        approvalIds: ["approval-stale"],
                        config: CONFIG,
                        run: { epoch, streamId },
                        threadId,
                        userId: OWNER,
                    }),
            );
        const counts = async () =>
            await harness.run(async (ctx: any) => {
                const approvals = await ctx.db.query("toolApprovalRuns").collect();
                const notifications = await ctx.db.query("notifications").collect();

                return { approvals: approvals.length, notifications: notifications.length };
            });

        const before = await counts();

        // The old invocation (epoch 0) finishes after the resume claimed the stream (epoch 1).
        await expect(record(0)).rejects.toMatchObject({ code: "RUN_REPLACED" });
        expect(await counts()).toStrictEqual(before);

        await record(1);
        expect(await counts()).toStrictEqual({ approvals: before.approvals + 1, notifications: before.notifications + 1 });
    });
});
