import { describe, expect, it, vi } from "vitest";

import { ErrorUtilities, NetworkError, TimeoutError } from ".";

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
    it("says a timed-out request may still complete, not that the connection failed", () => {
        const message = ErrorUtilities.getUserMessage(new TimeoutError(30_000));

        expect(message).toContain("may still complete");
        expect(message).not.toContain("Connection error");
    });

    it("keeps the connection wording for a plain network error", () => {
        expect(ErrorUtilities.getUserMessage(new NetworkError("offline"))).toContain("Connection error");
    });
});
