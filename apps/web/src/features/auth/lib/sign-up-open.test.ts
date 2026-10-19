import { describe, expect, it } from "vitest";

import { isSignUpOpen } from "./sign-up-open";

describe(isSignUpOpen, () => {
    it("stays closed unless explicitly turned off", () => {
        expect(isSignUpOpen(undefined)).toBe(false);
        expect(isSignUpOpen("")).toBe(false);
        expect(isSignUpOpen("true")).toBe(false);
        expect(isSignUpOpen("anything")).toBe(false);
    });

    it("opens on 'false' or '0'", () => {
        expect(isSignUpOpen("false")).toBe(true);
        expect(isSignUpOpen("0")).toBe(true);
    });

    it("compares the raw value, as the backend does", () => {
        expect(isSignUpOpen(" false")).toBe(false);
        expect(isSignUpOpen("0 ")).toBe(false);
    });
});
