/**
 * The approval category the phone registers: its identifier, and the approve and deny actions an alert carries.
 */
import { describe, expect, it } from "vitest";

import { approvalActionsFor, registerApprovalActionsWith } from "./approval-category";
import { APPROVE_ACTION, DENY_ACTION, TOOL_APPROVAL_CATEGORY } from "./approval-response";

describe("registerApprovalActionsWith", () => {
    it("registers the tool approval category with approve and deny, each needing the device unlocked and opening the app", async () => {
        const calls: { actions: unknown; identifier: string }[] = [];

        await registerApprovalActionsWith(async (identifier, actions) => {
            calls.push({ actions, identifier });
        });

        expect(calls).toHaveLength(1);
        expect(calls[0]?.identifier).toBe(TOOL_APPROVAL_CATEGORY);
        expect(calls[0]?.actions).toStrictEqual([
            { buttonTitle: "Approve", identifier: APPROVE_ACTION, options: { isAuthenticationRequired: true, opensAppToForeground: true } },
            {
                buttonTitle: "Deny",
                identifier: DENY_ACTION,
                options: { isAuthenticationRequired: true, isDestructive: true, opensAppToForeground: true },
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

describe("approvalActionsFor", () => {
    it("titles the actions in the phone's language, by its base language", () => {
        expect(approvalActionsFor("de-DE").map((action) => action.buttonTitle)).toStrictEqual(["Genehmigen", "Ablehnen"]);
        expect(approvalActionsFor("fr_CA").map((action) => action.buttonTitle)).toStrictEqual(["Approuver", "Refuser"]);
    });

    it("gives Traditional Chinese for a Traditional script or region, and Simplified for the rest of Chinese", () => {
        expect(approvalActionsFor("zh-Hant-TW").map((action) => action.buttonTitle)).toStrictEqual(["批准", "拒絕"]);
        expect(approvalActionsFor("zh-Hant").map((action) => action.buttonTitle)).toStrictEqual(["批准", "拒絕"]);
        expect(approvalActionsFor("zh-HK").map((action) => action.buttonTitle)).toStrictEqual(["批准", "拒絕"]);
        expect(approvalActionsFor("zh-CN").map((action) => action.buttonTitle)).toStrictEqual(["批准", "拒绝"]);
    });

    it("falls back to English for an unknown or missing language, and for one that only names a prototype property", () => {
        expect(approvalActionsFor(undefined).map((action) => action.buttonTitle)).toStrictEqual(["Approve", "Deny"]);
        expect(approvalActionsFor("xx").map((action) => action.buttonTitle)).toStrictEqual(["Approve", "Deny"]);
        expect(approvalActionsFor("constructor").map((action) => action.buttonTitle)).toStrictEqual(["Approve", "Deny"]);
    });
});
