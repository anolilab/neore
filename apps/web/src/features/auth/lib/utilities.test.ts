import { describe, expect, it } from "vitest";

import { errorCodeToCamelCase, getKeyByValue, isValidEmail } from "./utilities";

describe("isValidEmail", () => {
    it("should return true for valid emails", () => {
        expect(isValidEmail("user@example.com")).toBe(true);
        expect(isValidEmail("test@sub.domain.com")).toBe(true);
        expect(isValidEmail("name123@test.io")).toBe(true);
    });

    it("should return false for invalid emails", () => {
        expect(isValidEmail("")).toBe(false);
        expect(isValidEmail("notanemail")).toBe(false);
        expect(isValidEmail("@example.com")).toBe(false);
        expect(isValidEmail("user@")).toBe(false);
        expect(isValidEmail("user @example.com")).toBe(false);
    });
});

describe("errorCodeToCamelCase", () => {
    it("should convert SNAKE_CASE to camelCase", () => {
        expect(errorCodeToCamelCase("INVALID_TWO_FACTOR_COOKIE")).toBe("invalidTwoFactorCookie");
        expect(errorCodeToCamelCase("USER_NOT_FOUND")).toBe("userNotFound");
        expect(errorCodeToCamelCase("ACCOUNT_LOCKED")).toBe("accountLocked");
    });

    it("should handle single word codes", () => {
        expect(errorCodeToCamelCase("FORBIDDEN")).toBe("forbidden");
        expect(errorCodeToCamelCase("UNAUTHORIZED")).toBe("unauthorized");
    });

    it("should handle already lowercase input", () => {
        expect(errorCodeToCamelCase("already_lowercase")).toBe("alreadyLowercase");
    });
});

describe("getKeyByValue", () => {
    it("should find key by its value", () => {
        const object = { a: 1, b: 2, c: 3 };

        expect(getKeyByValue(object, 2)).toBe("b");
    });

    it("should return undefined for non-existent value", () => {
        const object = { a: 1, b: 2 };

        expect(getKeyByValue(object, 99)).toBeUndefined();
    });

    it("should return the first matching key", () => {
        const object = { a: "x", b: "y", c: "x" };
        const result = getKeyByValue(object, "x");

        expect(result === "a" || result === "c").toBe(true);
    });

    it("should return undefined when value is undefined", () => {
        const object = { a: 1 };

        expect(getKeyByValue(object, undefined)).toBeUndefined();
    });
});
