/**
 * An organization's cap on coding agents on a paired computer. Their tools are approved on the computer, out of the
 * backend's reach, so an organization allows them only at the `auto` cap. Every way an agent is started or sent a turn
 * checks it: the worker path (`sub-agents/functions.ts`), a start from the web, a send, a switch, a context reset and the
 * pull-request guide.
 */
import type { Doc } from "../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import { getMemberByOrganizationAndUser } from "../../auth/lib/better-auth-queries";
import { LEFT_ORGANIZATION_MESSAGE } from "../../auth/lib/organization-policy";
import { readOrganizationPermissionCap } from "../../auth/lib/permission-cap-read";

export const HOST_NOT_UNDER_AUTO = "Your organization does not allow agents on your computer.";

/** Which of the two refusals {@link hostOrganizationRefusal} gave, for a caller that answers with a code. */
export type HostOrganizationRefusal = "left_organization" | "not_allowed";

/**
 * The organization whose cap holds a host thread: the one it is filed under, else the one a temporary chat started in,
 * else the caller's verified active organization (a thread from before host threads were filed is capped like any
 * personal chat, by the space it is used from).
 */
export const hostOrganizationOf = (
    thread: Pick<Doc<"threads">, "capOrganizationId" | "organizationId"> | null,
    callerOrganizationId: string | null | undefined,
): string | undefined => thread?.organizationId ?? thread?.capOrganizationId ?? callerOrganizationId ?? undefined;

/** Why an agent on a computer cannot run for this organization as a code, or `null`: the owner left it, or its cap is not `auto`. */
export const hostOrganizationRefusalCode = async (
    ctx: MutationCtx | QueryCtx,
    organizationId: string | null | undefined,
    userId: string,
): Promise<HostOrganizationRefusal | null> => {
    if (!organizationId) {
        return null;
    }

    // From the primary: a replica can still hold a membership that was just revoked.
    if (!(await getMemberByOrganizationAndUser(ctx, organizationId, userId, "primary"))) {
        return "left_organization";
    }

    return (await readOrganizationPermissionCap(ctx, organizationId)) === "auto" ? null : "not_allowed";
};

/** The message shown to the owner for {@link hostOrganizationRefusalCode}'s refusal, or `null`. */
export const hostOrganizationRefusal = async (
    ctx: MutationCtx | QueryCtx,
    organizationId: string | null | undefined,
    userId: string,
): Promise<string | null> => {
    const code = await hostOrganizationRefusalCode(ctx, organizationId, userId);

    if (code === null) {
        return null;
    }

    return code === "left_organization" ? LEFT_ORGANIZATION_MESSAGE : HOST_NOT_UNDER_AUTO;
};
