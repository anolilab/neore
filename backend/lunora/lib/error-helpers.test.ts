import { describe, expect, it } from "vitest";

import { throwBadRequest, throwForbidden, throwInternalError, throwNotFound, throwThreadNotFound, throwUnauthorized } from "./error-helpers";

describe("throwUnauthorized", () => {
    it("should throw with default message", () => {
        expect(() => throwUnauthorized()).toThrow();
    });

    it("should throw with custom message", () => {
        expect(() => throwUnauthorized("Custom auth error")).toThrow("Custom auth error");
    });

    it("should throw an error with UNAUTHORIZED code", () => {
        // `expect(…).toThrow()` rather than try/catch + `expect.unreachable`.
        // The helpers are typed `(…) => never` now, so TypeScript knows the call
        // cannot fall through and flagged the assertion after it as unreachable.
        expect(() => throwUnauthorized()).toThrowError(expect.objectContaining({ code: "UNAUTHORIZED" }));
    });
});

describe("throwNotFound", () => {
    it("should throw with resource name in message", () => {
        expect(() => throwNotFound("Thread")).toThrow("Thread not found");
        expect(() => throwNotFound("User")).toThrow("User not found");
    });

    it("should throw an error with NOT_FOUND code", () => {
        // `expect(…).toThrow()` rather than try/catch + `expect.unreachable`.
        // The helpers are typed `(…) => never` now, so TypeScript knows the call
        // cannot fall through and flagged the assertion after it as unreachable.
        expect(() => throwNotFound("Resource")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    });
});

describe("throwThreadNotFound", () => {
    it("should throw with default message", () => {
        expect(() => throwThreadNotFound()).toThrow();
    });

    it("should throw with custom message", () => {
        expect(() => throwThreadNotFound("Thread was deleted")).toThrow("Thread was deleted");
    });

    it("should throw an error with NOT_FOUND code", () => {
        // `expect(…).toThrow()` rather than try/catch + `expect.unreachable`.
        // The helpers are typed `(…) => never` now, so TypeScript knows the call
        // cannot fall through and flagged the assertion after it as unreachable.
        expect(() => throwThreadNotFound()).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    });
});

describe("throwForbidden", () => {
    it("should throw with default message", () => {
        expect(() => throwForbidden()).toThrow();
    });

    it("should throw with custom message", () => {
        expect(() => throwForbidden("Not allowed")).toThrow("Not allowed");
    });

    it("should throw an error with FORBIDDEN code", () => {
        // `expect(…).toThrow()` rather than try/catch + `expect.unreachable`.
        // The helpers are typed `(…) => never` now, so TypeScript knows the call
        // cannot fall through and flagged the assertion after it as unreachable.
        expect(() => throwForbidden()).toThrowError(expect.objectContaining({ code: "FORBIDDEN" }));
    });
});

describe("throwBadRequest", () => {
    it("should throw with the provided message", () => {
        expect(() => throwBadRequest("Invalid input")).toThrow("Invalid input");
    });

    it("should throw an error with BAD_REQUEST code", () => {
        // `expect(…).toThrow()` rather than try/catch + `expect.unreachable`.
        // The helpers are typed `(…) => never` now, so TypeScript knows the call
        // cannot fall through and flagged the assertion after it as unreachable.
        expect(() => throwBadRequest("bad")).toThrowError(expect.objectContaining({ code: "BAD_REQUEST" }));
    });
});

describe("throwInternalError", () => {
    it("should throw with the provided message", () => {
        expect(() => throwInternalError("Something broke")).toThrow("Something broke");
    });

    it("should throw an error with INTERNAL_SERVER_ERROR code", () => {
        // `expect(…).toThrow()` rather than try/catch + `expect.unreachable`.
        // The helpers are typed `(…) => never` now, so TypeScript knows the call
        // cannot fall through and flagged the assertion after it as unreachable.
        expect(() => throwInternalError("error")).toThrowError(expect.objectContaining({ code: "INTERNAL_SERVER_ERROR" }));
    });
});
