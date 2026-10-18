import { describe, expect, it, vi } from "vitest";

import { internal } from "../_generated/internal";
import { buildExecutionContext, resolveRunAccount } from "./run-setup";

/** The account of a session-bound run, read the way the HTTP and action entry points both read it. */
const contextFor = (identity: Record<string, unknown> | null, answers: { activeOrg?: string | null; plan?: "premium" | null; role?: string | null }) => {
    const runQuery = vi.fn(async (reference: unknown, _args?: unknown) => {
        if (reference === internal.auth.session_organization.getActiveOrganizationIdForSession) {
            return answers.activeOrg ?? null;
        }

        if (reference === internal.auth.functions.getUserAuthFlagsQuery) {
            return { isAnonymous: false, plan: answers.plan ?? null, role: answers.role ?? null };
        }

        throw new Error("unexpected query");
    });

    return { auth: { getIdentity: async () => identity }, runQuery };
};

describe("resolveRunAccount", () => {
    it("reads the plan and the credits organization from the same session's active organization", async () => {
        const ctx = contextFor({ sessionId: "s1" }, { activeOrg: "org-paid", plan: "premium" });

        await expect(resolveRunAccount(ctx as never, "u1")).resolves.toStrictEqual({
            isAdmin: false,
            isAnonymous: false,
            orgId: "org-paid",
            plan: "premium",
        });
        expect(ctx.runQuery).toHaveBeenCalledWith(internal.auth.functions.getUserAuthFlagsQuery, { sessionId: "s1", userId: "u1" });
    });

    it("is a personal run with no organization and no session", async () => {
        const ctx = contextFor(null, { plan: null, role: "admin" });

        await expect(resolveRunAccount(ctx as never, "u1")).resolves.toStrictEqual({ isAdmin: true, isAnonymous: false, orgId: undefined, plan: null });
        expect(ctx.runQuery).not.toHaveBeenCalledWith(internal.auth.session_organization.getActiveOrganizationIdForSession, expect.anything());
    });
});

describe("buildExecutionContext", () => {
    it("carries the account's organization, so a clip is charged to the run's own organization", () => {
        const context = buildExecutionContext({
            account: { isAdmin: false, isAnonymous: false, orgId: "org-paid", plan: "premium" },
            content: { edges: [], nodes: [] },
            runId: "exec-1",
        });

        expect(context).toMatchObject({ orgId: "org-paid", runId: "exec-1", variables: {} });
    });
});
