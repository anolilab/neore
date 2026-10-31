import type { ToolPart } from "../types/message";

export interface AutoApproval {
    reason: string;
}

/** The longest reason shown: it is model text shaped by the call's arguments, so it is capped and shown as plain text. */
const MAX_REASON_LENGTH = 300;

/**
 * Why the user's opt-in quick check let this call run without asking, when it did
 * (`callProviderMetadata.neore.autoApproval`, stamped by the backend). `null` for
 * every call a person approved or that needed no approval.
 */
export const resolveAutoApproval = (part: Pick<ToolPart, "callProviderMetadata">): AutoApproval | null => {
    const record = part.callProviderMetadata?.neore?.autoApproval;

    if (typeof record !== "object" || record === null || (record as { by?: unknown }).by !== "quick-check") {
        return null;
    }

    const { reason } = record as { reason?: unknown };

    return typeof reason === "string" && reason.trim() ? { reason: reason.trim().slice(0, MAX_REASON_LENGTH) } : null;
};
