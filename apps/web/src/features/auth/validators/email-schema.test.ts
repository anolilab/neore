import { describe, expect, it } from "vitest";

import emailSchema from "./email-schema";

describe("emailSchema", () => {
    describe("valid emails", () => {
        it.each(["user@example.com", "john.doe@gmail.com", "test@sub.domain.co.uk", "firstname.lastname@company.org", "user123@test.io", "a@bb.cc"])(
            "should accept valid email: %s",
            (email) => {
                const result = emailSchema.safeParse(email);

                expect(result.success).toBe(true);
            },
        );
    });

    describe("rejects too short or too long emails", () => {
        it("should reject emails shorter than 5 characters", () => {
            const result = emailSchema.safeParse("a@b");

            expect(result.success).toBe(false);
        });

        it("should reject emails longer than 254 characters", () => {
            const local = "a".repeat(64);
            const domain = `${"b".repeat(186)}.com`;
            const result = emailSchema.safeParse(`${local}@${domain}`);

            expect(result.success).toBe(false);
        });
    });

    describe("rejects aliasing via +", () => {
        it.each(["user+tag@gmail.com", "user+test+extra@example.com", "name+alias@company.org"])("should reject email with + aliasing: %s", (email) => {
            const result = emailSchema.safeParse(email);

            expect(result.success).toBe(false);
        });
    });

    describe("rejects double dots", () => {
        it("should reject double dots in local part", () => {
            const result = emailSchema.safeParse("user..name@example.com");

            expect(result.success).toBe(false);
        });

        it("should reject double dots in domain", () => {
            const result = emailSchema.safeParse("user@example..com");

            expect(result.success).toBe(false);
        });
    });

    describe("rejects leading/trailing dots in local part", () => {
        it("should reject leading dot", () => {
            const result = emailSchema.safeParse(".user@example.com");

            expect(result.success).toBe(false);
        });

        it("should reject trailing dot", () => {
            const result = emailSchema.safeParse("user.@example.com");

            expect(result.success).toBe(false);
        });
    });

    describe("rejects invalid domain", () => {
        it("should reject domain without dot", () => {
            const result = emailSchema.safeParse("user@localhost");

            expect(result.success).toBe(false);
        });

        it("should reject TLD shorter than 2 characters", () => {
            const result = emailSchema.safeParse("user@example.c");

            expect(result.success).toBe(false);
        });
    });

    describe("rejects invalid format", () => {
        it.each(["", "notanemail", "@example.com", "user@", "user @example.com", "user@ example.com"])("should reject invalid format: '%s'", (email) => {
            const result = emailSchema.safeParse(email);

            expect(result.success).toBe(false);
        });
    });
});
