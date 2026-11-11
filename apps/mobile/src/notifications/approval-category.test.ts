/**
 * The approval category the phone registers: its identifier, and the approve and deny actions an alert carries.
 */
import { describe, expect, it } from "vitest";

import { registerApprovalActionsWith } from "./approval-category";
import { APPROVE_ACTION, DENY_ACTION, TOOL_APPROVAL_CATEGORY } from "./approval-response";

describe("registerApprovalActionsWith", () => {
    it("registers the tool approval category with approve and deny, neither opening the app", async () => {
        const calls: { actions: unknown; identifier: string }[] = [];

        await registerApprovalActionsWith(async (identifier, actions) => {
            calls.push({ actions, identifier });
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.identifier).toBe(TOOL_APPROVAL_CATEGORY);
        expect(calls[0]?.actions).toStrictEqual([
            {
                buttonTitle: "Approve",
                identifier: APPROVE_ACTION,
                options: { isAuthenticationRequired: true, opensAppToForeground: false },
            },
            {
                buttonTitle: "Deny",
                identifier: DENY_ACTION,
                options: { isAuthenticationRequired: true, isDestructive: true, opensAppToForeground: false },
            },
        ]);
    });

    it("lets a failed registration reach the caller, so the setup can retry", async () => {
        await expect(
            registerApprovalActionsWith(async () => {
                throw new Error("device refused");
            }),
        ).rejects.toThrow("device refused");
    });
});
