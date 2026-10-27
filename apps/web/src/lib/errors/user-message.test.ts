import { describe, expect, it, vi } from "vitest";

import { ErrorUtilities, GatewayDeadlineError, NetworkError, TimeoutError } from ".";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted); a descriptor carries its English source.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = String.raw({ raw: strings }, ...values);

            return { id: text, message: text };
        },
        plural: () => "",
    };
});

describe("ErrorUtilities.getUserMessage", () => {
    it("gives any other timeout the generic wording", () => {
        expect(ErrorUtilities.getUserMessage(new TimeoutError(30_000))).toBe("The request timed out. Please try again.");
    });

    it("tells a chat gateway deadline to check the conversation, not that the connection failed", () => {
        const message = ErrorUtilities.getUserMessage(new GatewayDeadlineError(30_000));

        expect(message).toContain("may still complete");
        expect(message).not.toContain("Connection error");
    });

    it("keeps the connection wording for a plain network error", () => {
        expect(ErrorUtilities.getUserMessage(new NetworkError("offline"))).toContain("Connection error");
    });
});
