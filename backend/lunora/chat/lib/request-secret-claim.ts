/**
 * Answering a `requestSecret` card (`chat/tools/request-secret.ts`) and keeping
 * the value it carries — `answerSecretRequest`'s core, kept apart from the
 * procedure so it can be driven against a real schema in tests.
 *
 * It is `claimToolApproval` plus one rule each way, like `claimAskUserAnswer`:
 * the claimed request must be a `requestSecret` call, and a saved value must be
 * non-empty and fit the destination the agent named. A throw rolls the claim
 * back. Saving encrypts the value into `requestedSecrets` and hands back only the
 * reference; declining stores nothing. A header's destination also gets the URL of
 * the named server as it is now, so the value goes to that server later and not to
 * another that takes the name.
 */
import { LunoraError } from "lunorash/server";

import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import type { SecretUse } from "../tools/request-secret-constants";
import { REQUEST_SECRET_TOOL_NAME, SECRET_DECLINED_REASON, SECRET_HEADER_VALUE_FORBIDDEN_RE, SECRET_LABEL_MAX } from "../tools/request-secret-constants";
import { invalidSecretUse, secretValueMax, storeRequestedSecret } from "./secret-requests";
import type { ClaimResult } from "./tool-approval-claim";
import { claimToolApproval, findPendingRequestOnLatestTurn } from "./tool-approval-claim";

export type SecretReply = { kind: "decline" } | { kind: "save"; value: string };

export type SecretClaim = ClaimResult & { ref?: string; use?: SecretUse };

interface StoredRequest {
    label?: unknown;
    use?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const asUse = (value: unknown): SecretUse | undefined => {
    if (!isRecord(value)) {
        return undefined;
    }

    if (value.kind === "provider_key" && typeof value.provider === "string") {
        return { kind: "provider_key", provider: value.provider };
    }

    if (value.kind === "mcp_header" && typeof value.header === "string" && typeof value.server === "string") {
        return { header: value.header, kind: "mcp_header", server: value.server };
    }

    return undefined;
};

/** The destination with the address of the server it names, which must be exactly one of the owner's saved ones. */
const withServerUrl = async (ctx: Pick<MutationCtx, "db">, ownerId: string, use: SecretUse): Promise<SecretUse> => {
    if (use.kind !== "mcp_header") {
        return use;
    }

    const preferences = await ctx.db
        .query("aiUserPreferences")
        .withIndex("by_userId", (q) => q.eq("userId", ownerId))
        .unique();
    const matches = (preferences?.mcpServers ?? []).filter((server) => server.name === use.server);

    if (matches.length === 0) {
        throw new LunoraError("BAD_REQUEST", `There is no saved MCP server named "${use.server}"; add it in Settings first`);
    }

    if (matches.length > 1) {
        throw new LunoraError("BAD_REQUEST", `More than one saved MCP server is named "${use.server}"; rename one in Settings first`);
    }

    return { ...use, url: matches[0]!.url };
};

export const claimSecretAnswer = async (
    ctx: Pick<MutationCtx, "db">,
    args: { approvalId: string; callerId: string; now: number; reply: SecretReply; threadId: Id<"threads">; unlockProof?: string | null },
): Promise<SecretClaim> => {
    const { approvalId, callerId, now, reply, threadId, unlockProof } = args;
    const claim = await claimToolApproval(ctx, {
        approvalId,
        callerId,
        decision: reply.kind === "save" ? "approve" : "deny",
        threadId,
        unlockProof,
    });

    if (claim.kind !== "claimed") {
        return claim;
    }

    if (claim.toolName !== REQUEST_SECRET_TOOL_NAME) {
        throw new LunoraError("BAD_REQUEST", "This request is not a secret request");
    }

    if (reply.kind === "decline") {
        return claim;
    }

    // The call's own input names the destination: the card showed it, and the value is bound to it.
    const requested = await findPendingRequestOnLatestTurn(ctx, threadId, approvalId);
    const input = (isRecord(requested?.input) ? requested.input : {}) as StoredRequest;
    const asked = asUse(input.use);

    if (asked === undefined || invalidSecretUse(asked) !== undefined) {
        throw new LunoraError("BAD_REQUEST", "This secret request has no valid destination");
    }

    // A continuation runs as the owner, but a consumer spends a reference only in a turn the owner started (`takeRequestedSecret`):
    // a value stored for a collaborator's turn could never be used.
    if (claim.config.startedBy !== claim.ownerId) {
        throw new LunoraError(
            "BAD_REQUEST",
            "Only a reply you started can use a secret, and someone else started this one. Decline it, or ask again in your own message",
        );
    }

    const value = reply.value.trim();

    if (value.length === 0 || value.length > secretValueMax(asked)) {
        throw new LunoraError("BAD_REQUEST", "Provide a value that fits where it is going");
    }

    if (asked.kind === "mcp_header" && SECRET_HEADER_VALUE_FORBIDDEN_RE.test(value)) {
        throw new LunoraError("BAD_REQUEST", "A header value cannot contain a line break, a control character or a character above U+00FF");
    }

    const use = await withServerUrl(ctx, claim.ownerId, asked);

    const label = typeof input.label === "string" ? input.label.slice(0, SECRET_LABEL_MAX) : "Secret";
    const ref = await storeRequestedSecret(ctx, {
        approvalId,
        label,
        now,
        ...(claim.config.replyKey !== undefined && { replyKey: claim.config.replyKey }),
        threadId,
        use,
        userId: claim.ownerId,
        value,
    });

    return { ...claim, ref, use };
};

/** What `resumeClaimedRun` gets: the reference for a saved value, a denial for a decline — never the value. */
export const secretResumeArgs = (claim: SecretClaim & { kind: "claimed" }): { answer: string; approved: true } | { approved: false; denyReason: string } =>
    claim.ref === undefined ? { approved: false, denyReason: SECRET_DECLINED_REASON } : { answer: claim.ref, approved: true };
