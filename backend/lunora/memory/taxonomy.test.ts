import { describe, expect, it } from "vitest";

import { isMemoryType, lastConfirmedOf } from "./taxonomy";

describe("isMemoryType", () => {
    it("accepts the five types and nothing else", () => {
        expect(["identity", "preference", "context", "activity", "experience"].every(isMemoryType)).toBe(true);
        expect(isMemoryType("observation")).toBe(false);
        expect(isMemoryType(undefined)).toBe(false);
    });
});

describe("lastConfirmedOf", () => {
    it("falls back from the stamp to the last write to creation", () => {
        expect(lastConfirmedOf({ _creationTime: 1, lastConfirmedAt: 3, updatedAt: 2 })).toBe(3);
        expect(lastConfirmedOf({ _creationTime: 1, updatedAt: 2 })).toBe(2);
        expect(lastConfirmedOf({ _creationTime: 1 })).toBe(1);
    });
});
