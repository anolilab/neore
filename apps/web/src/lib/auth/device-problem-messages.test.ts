import { describe, expect, it, vi } from "vitest";

import { DEVICE_PROBLEM_MESSAGES } from "./device-problem-messages";

// The unit-test transform does not compile Lingui macros (vi.mock is hoisted); a descriptor carries its English source.
vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray, ...values: unknown[]) => {
            const text = String.raw({ raw: strings }, ...values);

            return { id: text, message: text };
        },
    };
});

describe("DEVICE_PROBLEM_MESSAGES", () => {
    it("names the recovery for either kind of code when the lookup cannot say which it was", () => {
        for (const problem of ["expired", "invalid"] as const) {
            const text = String(DEVICE_PROBLEM_MESSAGES[problem].message);

            expect(text).toContain("neore login --device");
            expect(text).toContain("neore-host pair");
        }
    });

    it("only sends a key-cap refusal back to the command line, where it can happen", () => {
        expect(String(DEVICE_PROBLEM_MESSAGES.keyLimit.message)).not.toContain("neore-host");
    });
});
