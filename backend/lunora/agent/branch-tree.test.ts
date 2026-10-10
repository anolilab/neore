/**
 * The pure half of branching. The walk that serves requests is pinned by
 * `branch-rows.test.ts`; `buildBranchTree` here is only the whole-thread form a
 * fork and a deleted leaf fall back to.
 */
import { describe, expect, it } from "vitest";

import type { BranchParentInput, BranchRow, ForkPathRow } from "./branch-tree";
import { BRANCH_ROOT, buildBranchTree, forkEnd, resolveActivePath, resolveBranchParent } from "./branch-tree";

const row = (_id: string, order: number, stepOrder: number, parentMessageId?: string): BranchRow => {
    return { _id, order, parentMessageId, stepOrder };
};

/** u1 → a1 (two steps) → u2 → a2, written before branching existed. */
const legacyRows = [row("u1", 0, 0), row("a1", 0, 1), row("a1-step2", 0, 2), row("u2", 1, 0), row("a2", 1, 1)];

describe("whole-thread branch tree", () => {
    it("is order-independent in its input", () => {
        expect(resolveActivePath(buildBranchTree(legacyRows.toReversed()))).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2"]);
    });

    it("degrades a stored leaf that no longer exists to the latest path", () => {
        const tree = buildBranchTree([...legacyRows, row("u2b", 2, 0, "a1-step2"), row("a2c", 2, 1)]);

        expect(resolveActivePath(tree, "deleted")).toStrictEqual(["u1", "a1", "a1-step2", "u2b", "a2c"]);
        expect(resolveActivePath(tree, "u2")).toStrictEqual(["u1", "a1", "a1-step2", "u2", "a2"]);
    });

    it("returns an empty path for an empty thread", () => {
        expect(resolveActivePath(buildBranchTree([]))).toStrictEqual([]);
    });

    it("falls back to the previous row for a forward or dangling parent", () => {
        const tree = buildBranchTree([row("u1", 0, 0), row("a1", 0, 1, "a-later"), row("a-later", 0, 2), row("u2", 1, 0, "gone")]);

        expect(resolveActivePath(tree)).toStrictEqual(["u1", "a1", "a-later", "u2"]);
    });

    it("starts a top-level sibling for BRANCH_ROOT", () => {
        expect(resolveActivePath(buildBranchTree([...legacyRows, row("u1b", 2, 0, BRANCH_ROOT)]))).toStrictEqual(["u1b"]);
    });
});

describe(resolveBranchParent, () => {
    const base: BranchParentInput = { continuationHasRows: false, patchesPending: false };
    const userPrompt = { _id: "p", role: "user" };
    const toolPrompt = { _id: "p", role: "tool" };

    it.each<[string, Partial<BranchParentInput>, string | undefined]>([
        ["an append to an unbranched thread", { firstRole: "user" }, undefined],
        ["an explicit parent", { explicitParentId: "x" }, "x"],
        ["an explicit parent over a prompt", { explicitParentId: "x", failPendingSteps: true, prompt: userPrompt, promptMessageId: "p" }, "x"],
        ["a reply to a prompt (regenerate)", { failPendingSteps: true, prompt: userPrompt, promptMessageId: "p" }, "p"],
        ["a user prompt without failPendingSteps", { prompt: userPrompt, promptMessageId: "p" }, undefined],
        ["a tool result answering an approval", { prompt: toolPrompt, promptMessageId: "p" }, "p"],
        ["a continuation's first save", { explicitParentId: "x", overrideOrder: 4 }, "x"],
        ["a continuation's later saves", { continuationHasRows: true, explicitParentId: "x", overrideOrder: 4 }, undefined],
        ["a continuation with a non-user prompt", { overrideOrder: 4, prompt: toolPrompt, promptMessageId: "p" }, undefined],
        ["a patched pending row", { explicitParentId: "x", patchesPending: true }, undefined],
        ["a pending reply to a prompt", { failPendingSteps: true, patchesPending: true, prompt: userPrompt, promptMessageId: "p" }, undefined],
        ["a new prompt in a branched thread", { activeLeafId: "stored", firstRole: "user" }, "leaf"],
        ["an assistant row in a branched thread", { activeLeafId: "stored", firstRole: "assistant" }, undefined],
        ["a new prompt in a branched thread, with a prompt id", { activeLeafId: "stored", firstRole: "user", promptMessageId: "gone" }, undefined],
    ])("%s", async (_, input, expected) => {
        await expect(resolveBranchParent({ ...base, ...input }, async () => "leaf")).resolves.toBe(expected);
    });

    it("hangs a new prompt at the top level when the leaf cannot be resolved", async () => {
        await expect(resolveBranchParent({ ...base, activeLeafId: "stored", firstRole: "user" }, async () => undefined)).resolves.toBe(BRANCH_ROOT);
    });

    it("reads the leaf only for a new prompt in a branched thread", async () => {
        let reads = 0;
        const load = async () => {
            reads += 1;

            return "leaf";
        };

        await resolveBranchParent({ ...base, activeLeafId: "stored", failPendingSteps: true, prompt: userPrompt, promptMessageId: "p" }, load);
        await resolveBranchParent({ ...base, activeLeafId: "stored", firstRole: "user", patchesPending: true }, load);

        expect(reads).toBe(0);
    });
});

describe(forkEnd, () => {
    // u1 → a1 (tool call, tool result, text) → u2 → a2, as the active path.
    const path: ForkPathRow[] = [
        { _id: "u1", order: 0, role: "user" },
        { _id: "a1", order: 0, role: "assistant" },
        { _id: "t1", order: 0, role: "tool" },
        { _id: "a1-text", order: 0, role: "assistant" },
        { _id: "u2", order: 1, role: "user" },
        { _id: "a2", order: 1, role: "assistant" },
    ];

    it("keeps every step of an assistant reply", () => {
        expect(forkEnd(path, { messageId: "a1" })?.endId).toBe("a1-text");
        expect(forkEnd(path, { messageId: "t1" })?.endId).toBe("a1-text");
    });

    it("forks at a user prompt alone", () => {
        expect(forkEnd(path, { messageId: "u2" })?.endId).toBe("u2");
    });

    it("resolves a display index against grouped messages, not rows", () => {
        expect(forkEnd(path, { index: 1 })?.endId).toBe("a1-text");
        expect(forkEnd(path, { index: 2 })?.endId).toBe("u2");
        expect(forkEnd(path, { index: 3 })?.endId).toBe("a2");
        expect(forkEnd(path, { index: 4 })).toBeUndefined();
    });

    it("splits assistant rows of different orders", () => {
        const continuation: ForkPathRow[] = [...path, { _id: "a2-cont", order: 5, role: "assistant" }];

        expect(forkEnd(continuation, { messageId: "a2" })?.endId).toBe("a2");
    });

    it("forks the whole path without a target, recording the last displayed position", () => {
        expect(forkEnd(path)).toStrictEqual({ endId: "a2", index: 3 });
        expect(forkEnd([])).toBeUndefined();
    });

    it("reports the displayed position of a message fork", () => {
        expect(forkEnd(path, { messageId: "t1" })).toStrictEqual({ endId: "a1-text", index: 1 });
    });

    it("refuses a message that is not on the path", () => {
        expect(forkEnd(path, { messageId: "off-path-sibling" })).toBeUndefined();
    });
});
