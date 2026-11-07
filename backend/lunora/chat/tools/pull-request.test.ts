/**
 * The pull request tools under the permission layer: the reads run unasked, reply and re-run ask by default, and a
 * merge is never run without a person approving it — not with the tool set to Auto, not under a time-boxed allow, and
 * not in a run nobody is at.
 */
import type { ToolSet } from "ai";
import { describe, expect, it } from "vitest";

import type { ToolCtx } from "../../agent/client/create-tool";
import { wrapTools } from "../../agent/client/create-tool";
import { isGrantableKey } from "../lib/tool-permission-grants";
import { applyToolPermissions, resolveToolPermission, toolPermissionKey } from "../lib/tool-permissions";
import { mergePullRequestTool, readFailingChecksTool, readPullRequestTool, replyToReviewCommentTool, rerunFailedChecksTool } from "./pull-request";

const builtin = (name: string) => {
    return { key: toolPermissionKey("builtin", name), source: "builtin" as const };
};

const asks = async (tool: ToolSet[string]): Promise<boolean> => {
    const { needsApproval } = tool;

    if (typeof needsApproval !== "function") {
        return needsApproval === true;
    }

    return await (needsApproval as (this: unknown, input: unknown, options: unknown) => boolean | Promise<boolean>).call(
        tool,
        {},
        { messages: [], toolCallId: "call-1" },
    );
};

const SET: ToolSet = {
    mergePullRequest: mergePullRequestTool,
    readFailingChecks: readFailingChecksTool,
    readPullRequest: readPullRequestTool,
    replyToReviewComment: replyToReviewCommentTool,
    rerunFailedChecks: rerunFailedChecksTool,
};

describe("pull request tool defaults", () => {
    it("runs the reads unasked and asks before a reply, a re-run or a merge", () => {
        expect(resolveToolPermission(builtin("readPullRequest"), undefined)).toBe("auto");
        expect(resolveToolPermission(builtin("readFailingChecks"), undefined)).toBe("auto");
        expect(resolveToolPermission(builtin("replyToReviewComment"), undefined)).toBe("ask");
        expect(resolveToolPermission(builtin("rerunFailedChecks"), undefined)).toBe("ask");
        expect(resolveToolPermission(builtin("mergePullRequest"), undefined)).toBe("ask");
    });

    it("lets the person allow a reply or a re-run without asking", async () => {
        const { tools } = applyToolPermissions(SET, () => undefined, { "builtin:replyToReviewComment": "auto", "builtin:rerunFailedChecks": "auto" });

        expect(await asks(tools.replyToReviewComment!)).toBe(false);
        expect(await asks(tools.rerunFailedChecks!)).toBe(false);
    });
});

describe("a merge without approval", () => {
    it("still asks when the person set the merge tool to Auto", async () => {
        const { tools } = applyToolPermissions(SET, () => undefined, { "builtin:mergePullRequest": "auto" });

        expect(tools.mergePullRequest).toBeDefined();
        expect(await asks(tools.mergePullRequest!)).toBe(true);
    });

    it("cannot be covered by a time-boxed allow", () => {
        expect(isGrantableKey("builtin:mergePullRequest")).toBe(false);
        expect(isGrantableKey("builtin:rerunFailedChecks")).toBe(true);
    });

    it("is removed from a run nobody is at, even when set to Auto", () => {
        const { removed, tools } = applyToolPermissions(SET, () => undefined, { "builtin:mergePullRequest": "auto" }, { headless: true });

        expect(removed).toContain("mergePullRequest");
        expect(tools.mergePullRequest).toBeUndefined();
        expect(tools.readPullRequest).toBeDefined();
    });

    it("is refused by the tool itself in a run nobody is at", async () => {
        const context = { headless: true, threadId: "thread-1", userId: "user-1" } as unknown as ToolCtx;
        const merge = wrapTools(context, { mergePullRequest: mergePullRequestTool }).mergePullRequest!;
        const output = await (merge.execute as (this: unknown, input: unknown, options: unknown) => Promise<unknown>).call(
            merge,
            { headSha: "a".repeat(40) },
            { messages: [], toolCallId: "call-1" },
        );

        expect(output).toMatchObject({ status: "headless" });
    });
});
