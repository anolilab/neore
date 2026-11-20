/**
 * `decideFact`, the per-fact decision extraction and the import share: when a near-match is confirmed, left alone,
 * or revised, and that a failed or empty revision saves the fact as new instead of losing it.
 */
import { describe, expect, it, vi } from "vitest";

import { decideFact, type SimilarMemoryResult } from "./dedup";

const match = (score: number, pinned = false): SimilarMemoryResult => {
    return { confidence: 70, id: "m1" as SimilarMemoryResult["id"], memory: "The user lives in Berlin", pinned, score };
};

const accept = (mergedMemory: string) => mergedMemory;

describe(decideFact, () => {
    it("saves a fact with no match as new", async () => {
        expect(await decideFact(null, { acceptMerge: accept, logPrefix: "[test]", revise: vi.fn() })).toStrictEqual({ action: "ADD" });
    });

    it("confirms a near-exact match without asking the model", async () => {
        const revise = vi.fn();

        expect(await decideFact(match(0.97), { acceptMerge: accept, logPrefix: "[test]", revise })).toStrictEqual({ action: "IGNORE", similar: match(0.97) });
        expect(revise).not.toHaveBeenCalled();
    });

    it("never revises a pinned match, and saves the fact beside it", async () => {
        const revise = vi.fn();

        expect(await decideFact(match(0.9, true), { acceptMerge: accept, logPrefix: "[test]", revise })).toStrictEqual({ action: "ADD" });
        expect(revise).not.toHaveBeenCalled();
    });

    it("saves the fact as new when the caller allows no revision", async () => {
        expect(await decideFact(match(0.9), { acceptMerge: accept, logPrefix: "[test]", revise: undefined })).toStrictEqual({ action: "ADD" });
    });

    it("saves the fact as new, marked failed, when the revision throws", async () => {
        vi.spyOn(console, "error").mockImplementation(() => undefined);

        const revise = vi.fn(async () => {
            throw new Error("model down");
        });

        expect(await decideFact(match(0.9), { acceptMerge: accept, logPrefix: "[test]", revise })).toStrictEqual({ action: "ADD", failed: true });
    });

    it("passes on the model's SUPERSEDE and IGNORE", async () => {
        const supersede = vi.fn(async () => {
            return { action: "SUPERSEDE" as const };
        });
        const ignore = vi.fn(async () => {
            return { action: "IGNORE" as const };
        });

        expect(await decideFact(match(0.9), { acceptMerge: accept, logPrefix: "[test]", revise: supersede })).toStrictEqual({
            action: "SUPERSEDE",
            similar: match(0.9),
        });
        expect(await decideFact(match(0.9), { acceptMerge: accept, logPrefix: "[test]", revise: ignore })).toStrictEqual({
            action: "IGNORE",
            similar: match(0.9),
        });
    });

    it("rewords the match only with merged text the caller accepts", async () => {
        const revise = vi.fn(async () => {
            return { action: "UPDATE" as const, mergedMemory: "The user lives in Berlin with a cat" };
        });

        expect(await decideFact(match(0.9), { acceptMerge: accept, logPrefix: "[test]", revise })).toStrictEqual({
            action: "UPDATE",
            merge: "The user lives in Berlin with a cat",
            similar: match(0.9),
        });
        expect(await decideFact(match(0.9), { acceptMerge: () => undefined, logPrefix: "[test]", revise })).toStrictEqual({ action: "ADD" });
    });

    it("saves the fact as new when an UPDATE carries no merged text", async () => {
        const revise = vi.fn(async () => {
            return { action: "UPDATE" as const };
        });

        expect(await decideFact(match(0.9), { acceptMerge: accept, logPrefix: "[test]", revise })).toStrictEqual({ action: "ADD" });
    });
});
