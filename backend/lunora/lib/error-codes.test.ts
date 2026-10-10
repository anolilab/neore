import { describe, expect, it } from "vitest";

import {
    AUTH_ERRORS,
    BUSINESS_ERRORS,
    CONNECTOR_ERRORS,
    ERROR_CODES,
    FILE_ERRORS,
    getErrorMessage,
    RATE_LIMIT_ERRORS,
    STREAMING_ERRORS,
    VALIDATION_ERRORS,
} from "./error-codes";

describe("ERROR_CODES", () => {
    it("should include all auth error codes", () => {
        expect(ERROR_CODES.NOT_AUTHENTICATED).toBe("NOT_AUTHENTICATED");
        expect(ERROR_CODES.TOKEN_EXPIRED).toBe("TOKEN_EXPIRED");
        expect(ERROR_CODES.UNAUTHORIZED).toBe("UNAUTHORIZED");
    });

    it("should include all validation error codes", () => {
        expect(ERROR_CODES.INVALID_INPUT).toBe("INVALID_INPUT");
        expect(ERROR_CODES.THREAD_NOT_FOUND).toBe("THREAD_NOT_FOUND");
        expect(ERROR_CODES.USER_NOT_FOUND).toBe("USER_NOT_FOUND");
        expect(ERROR_CODES.MESSAGE_NOT_FOUND).toBe("MESSAGE_NOT_FOUND");
    });

    it("should include all rate limit error codes", () => {
        expect(ERROR_CODES.DAILY_LIMIT_REACHED).toBe("DAILY_LIMIT_REACHED");
        expect(ERROR_CODES.MONTHLY_LIMIT_REACHED).toBe("MONTHLY_LIMIT_REACHED");
        expect(ERROR_CODES.PREMIUM_LIMIT_REACHED).toBe("PREMIUM_LIMIT_REACHED");
    });

    it("should include all business error codes", () => {
        expect(ERROR_CODES.PREMIUM_MODEL_ACCESS_DENIED).toBe("PREMIUM_MODEL_ACCESS_DENIED");
        expect(ERROR_CODES.UNSUPPORTED_MODEL).toBe("UNSUPPORTED_MODEL");
        expect(ERROR_CODES.USER_KEY_REQUIRED).toBe("USER_KEY_REQUIRED");
    });

    it("should be a combined superset of all error code groups", () => {
        const allCodes = {
            ...AUTH_ERRORS,
            ...VALIDATION_ERRORS,
            ...RATE_LIMIT_ERRORS,
            ...BUSINESS_ERRORS,
            ...FILE_ERRORS,
            ...CONNECTOR_ERRORS,
            ...STREAMING_ERRORS,
        };

        for (const [key, value] of Object.entries(allCodes)) {
            expect((ERROR_CODES as Record<string, string>)[key]).toBe(value);
        }
    });
});

describe("getErrorMessage", () => {
    describe("auth errors", () => {
        it("should return message for NOT_AUTHENTICATED", () => {
            expect(getErrorMessage(ERROR_CODES.NOT_AUTHENTICATED)).toContain("Authentication required");
        });

        it("should return message for TOKEN_EXPIRED", () => {
            expect(getErrorMessage(ERROR_CODES.TOKEN_EXPIRED)).toContain("session has expired");
        });

        it("should return message for UNAUTHORIZED", () => {
            expect(getErrorMessage(ERROR_CODES.UNAUTHORIZED)).toContain("not authorized");
        });
    });

    describe("validation errors", () => {
        it("should return message for INVALID_INPUT", () => {
            expect(getErrorMessage(ERROR_CODES.INVALID_INPUT)).toContain("Invalid input");
        });

        it("should return message for THREAD_NOT_FOUND", () => {
            expect(getErrorMessage(ERROR_CODES.THREAD_NOT_FOUND)).toContain("Thread not found");
        });

        it("should return message for USER_NOT_FOUND", () => {
            expect(getErrorMessage(ERROR_CODES.USER_NOT_FOUND)).toBe("User not found.");
        });
    });

    describe("rate limit errors", () => {
        it("should return message for DAILY_LIMIT_REACHED", () => {
            expect(getErrorMessage(ERROR_CODES.DAILY_LIMIT_REACHED)).toContain("daily usage limit");
        });

        it("should return message for MONTHLY_LIMIT_REACHED", () => {
            expect(getErrorMessage(ERROR_CODES.MONTHLY_LIMIT_REACHED)).toContain("monthly usage limit");
        });
    });

    describe("business errors", () => {
        it("should return message for PREMIUM_MODEL_ACCESS_DENIED", () => {
            expect(getErrorMessage(ERROR_CODES.PREMIUM_MODEL_ACCESS_DENIED)).toContain("premium subscription");
        });

        it("should return message for UNSUPPORTED_MODEL", () => {
            expect(getErrorMessage(ERROR_CODES.UNSUPPORTED_MODEL)).toContain("not supported");
        });
    });

    describe("file errors", () => {
        it("should return message for FILE_TOO_LARGE", () => {
            expect(getErrorMessage(ERROR_CODES.FILE_TOO_LARGE)).toContain("too large");
        });

        it("should return message for UPLOAD_FAILED", () => {
            expect(getErrorMessage(ERROR_CODES.UPLOAD_FAILED)).toContain("upload failed");
        });
    });

    describe("streaming errors", () => {
        it("should return message for PROVIDER_STREAM_RATE_LIMIT", () => {
            expect(getErrorMessage(ERROR_CODES.PROVIDER_STREAM_RATE_LIMIT)).toContain("rate limit");
        });

        it("should return message for PROVIDER_STREAM_AUTH_ERROR", () => {
            expect(getErrorMessage(ERROR_CODES.PROVIDER_STREAM_AUTH_ERROR)).toContain("API key");
        });
    });

    describe("connector errors", () => {
        it("should return message for CONNECTION_FAILED", () => {
            expect(getErrorMessage(ERROR_CODES.CONNECTION_FAILED)).toContain("Failed to establish");
        });

        it("should return message for CONNECTION_TIMEOUT", () => {
            expect(getErrorMessage(ERROR_CODES.CONNECTION_TIMEOUT)).toContain("timed out");
        });
    });

    it("should return default message for unknown error code", () => {
        const result = getErrorMessage("COMPLETELY_UNKNOWN" as any);

        expect(result).toContain("unexpected error");
    });
});
