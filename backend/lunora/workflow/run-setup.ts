/**
 * What both run paths (the action executor and the streaming endpoint) set up before a node runs: the
 * run's account, the refusals for the whole graph, and the execution context. One implementation, so the
 * two entry points cannot disagree on who pays or on what a run may start with.
 */
import type { ActionCtx } from "../_generated/server";
import { internal } from "../_generated/internal";
import type { ExecutionContext, WorkflowContent } from "./core";
import { workflowVideoErrors } from "./video-billing";
import { workflowInputErrors } from "./media-args";

/** The part of an action or HTTP action context the run setup reads through. */
type RunContext = Pick<ActionCtx, "auth" | "runQuery">;

/**
 * Who a run acts for, read once per run from its session. The organization is the session's ACTIVE one
 * (membership re-checked), or `undefined` for a personal run. The plan, the admin flag and the credits
 * account all come from that one organization, so the gate, the quota and the charge cannot disagree.
 */
export interface RunAccount {
    isAdmin: boolean;
    isAnonymous: boolean;
    /** The organization whose credits the run's paid clips draw on; `undefined` when the run has none. */
    orgId?: string;
    /** `premium` when the user's own plan, or the active organization's, is paid. */
    plan: "premium" | null;
}

/** Reads the run's account from `userId`'s session (`sessionId` is `undefined` when the caller has none). */
export const resolveRunAccount = async (context: RunContext, userId: string): Promise<RunAccount> => {
    const identity = await context.auth.getIdentity();
    const sessionId = typeof identity?.sessionId === "string" ? identity.sessionId : undefined;
    const [orgId, flags] = await Promise.all([
        sessionId ? context.runQuery(internal.auth.session_organization.getActiveOrganizationIdForSession, { sessionId, userId }) : null,
        context.runQuery(internal.auth.functions.getUserAuthFlagsQuery, { sessionId, userId }),
    ]);

    return {
        isAdmin: flags.role === "admin",
        isAnonymous: flags.isAnonymous,
        orgId: orgId ?? undefined,
        plan: flags.plan,
    };
};

/** Every refusal for a run, checked before any node runs so a doomed run bills nothing. */
export const workflowRunErrors = (account: RunAccount, content: Pick<WorkflowContent, "edges" | "nodes">): string[] => [
    ...workflowInputErrors(content),
    ...workflowVideoErrors(account, content.nodes, content.edges),
];

/** The execution context of one run. The organization is the account's, so a clip is charged to it. */
export const buildExecutionContext = (options: {
    account: RunAccount;
    content: Pick<WorkflowContent, "edges" | "nodes">;
    runId: string;
    variables?: Record<string, string>;
}): ExecutionContext => {
    return {
        data: {},
        graph: { edges: options.content.edges, nodes: options.content.nodes },
        nodeOutputs: {},
        orgId: options.account.orgId,
        runId: options.runId,
        variables: options.variables ?? {},
    };
};
