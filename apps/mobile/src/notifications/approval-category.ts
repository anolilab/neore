/**
 * The approval category the phone registers, without the device API: its actions, and the call that registers them through a
 * setter it is given. `approval-actions.ts` passes the real one.
 */
import { APPROVE_ACTION, DENY_ACTION, TOOL_APPROVAL_CATEGORY } from "./approval-response";

/** The actions a tool approval's alert carries. Neither opens the app: an answer is made from the alert itself. */
export const APPROVAL_ACTIONS = [
    { buttonTitle: "Approve", identifier: APPROVE_ACTION, options: { opensAppToForeground: false } },
    { buttonTitle: "Deny", identifier: DENY_ACTION, options: { isDestructive: true, opensAppToForeground: false } },
] as const;

export type ApprovalAction = (typeof APPROVAL_ACTIONS)[number];

/** Registers the approval category through `setCategory`, with a fresh copy of the actions. A failure reaches the caller to retry. */
export const registerApprovalActionsWith = async (
    setCategory: (identifier: string, actions: ApprovalAction[]) => Promise<unknown>,
): Promise<void> => {
    await setCategory(TOOL_APPROVAL_CATEGORY, [...APPROVAL_ACTIONS]);
};
