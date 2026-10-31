import { describe, expect, it } from "vitest";

import { resolveAutoApproval } from "./auto-approval";

describe("resolveAutoApproval", () => {
    it("reads the reason the backend stamped", () => {
        expect(
            resolveAutoApproval({ callProviderMetadata: { neore: { autoApproval: { at: 1, by: "quick-check", model: "m", reason: " Reads a forecast. " } } } }),
        ).toEqual({
            reason: "Reads a forecast.",
        });
    });

    it("is null for a call a person approved, or one with no record", () => {
        expect(resolveAutoApproval({})).toBeNull();
        expect(resolveAutoApproval({ callProviderMetadata: { neore: { mcpServerName: "s", mcpToolName: "t" } } })).toBeNull();
    });

    it("is null for a record that is not the quick check's or has no reason", () => {
        expect(resolveAutoApproval({ callProviderMetadata: { neore: { autoApproval: { by: "someone", reason: "x" } } } })).toBeNull();
        expect(resolveAutoApproval({ callProviderMetadata: { neore: { autoApproval: { by: "quick-check", reason: "  " } } } })).toBeNull();
        expect(resolveAutoApproval({ callProviderMetadata: { neore: { autoApproval: "yes" } } })).toBeNull();
    });

    it("caps a long reason", () => {
        const result = resolveAutoApproval({ callProviderMetadata: { neore: { autoApproval: { by: "quick-check", reason: "x".repeat(1000) } } } });

        expect(result?.reason).toHaveLength(300);
    });
});
