/**
 * A coding-agent task round never reaches `runHeadlessAgent`, so it makes the organization's checks itself: the owner
 * must still be a member, and the cap must be `auto`, since the agent approves its own tools.
 */
import { describe, expect, it, vi } from "vitest";

import { LEFT_ORGANIZATION_MESSAGE } from "../chat/lib/agent-run";
import { startCodingAgentRound } from "./execute";
import { stopsRecurrence } from "./run-error";

const refName = (reference: unknown): string => (typeof reference === "string" ? reference : (reference as { __lunoraRef: string }).__lunoraRef);

const fakeCtx = ({ cap, member }: { cap: "ask" | "auto" | "off"; member: boolean }) => {
    const runMutation = vi.fn(async () => {
        return { runId: "coding-run-1" };
    });
    const runQuery = vi.fn(async (reference: unknown) => {
        switch (refName(reference)) {
            case "auth_organization_policy:getPermissionCapQuery": {
                return cap;
            }
            case "auth_organization_policy:isOrganizationMemberQuery": {
                return member;
            }
            default: {
                throw new Error(`unexpected query ${refName(reference)}`);
            }
        }
    });

    return { ctx: { runMutation, runQuery } as never, runMutation };
};

const claim = (organizationId?: string) => {
    return {
        codingAgent: { agent: "codex" as const, repoUrl: "https://github.com/example/repo" },
        instructions: "Fix the build",
        ...(organizationId && { organizationId }),
        runId: "task-run-1" as never,
        title: "Fix",
        userId: "owner",
    };
};

describe("starting a coding-agent task round in an organization", () => {
    it("stops the task when its owner left the organization, starting nothing", async () => {
        const { ctx, runMutation } = fakeCtx({ cap: "auto", member: false });
        const refused = await startCodingAgentRound(ctx, claim("org-1"), "task-1" as never).catch((error: unknown) => error);

        expect(refused).toMatchObject({ kind: "left-organization", message: LEFT_ORGANIZATION_MESSAGE });
        expect(stopsRecurrence(refused)).toBe(true);
        expect(runMutation).not.toHaveBeenCalled();
    });

    it.each(["ask", "off"] as const)("refuses under an %s cap, starting nothing", async (cap) => {
        const { ctx, runMutation } = fakeCtx({ cap, member: true });

        await expect(startCodingAgentRound(ctx, claim("org-1"), "task-1" as never)).rejects.toThrow("organization's tool policy");
        expect(runMutation).not.toHaveBeenCalled();
    });

    it("starts the agent under an auto cap, and without an organization reads nothing", async () => {
        const capped = fakeCtx({ cap: "auto", member: true });
        const personal = fakeCtx({ cap: "off", member: false });

        await startCodingAgentRound(capped.ctx, claim("org-1"), "task-1" as never);
        await startCodingAgentRound(personal.ctx, claim(), "task-1" as never);

        expect(capped.runMutation).toHaveBeenCalledTimes(1);
        expect(personal.runMutation).toHaveBeenCalledTimes(1);
    });
});
