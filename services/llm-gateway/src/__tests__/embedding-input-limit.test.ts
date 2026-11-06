import { describe, expect, it } from "vitest";

import { EMBEDDING_MODELS, isTooLongForModel } from "../providers/embedding-factory.js";

describe(isTooLongForModel, () => {
    const bgeM3 = EMBEDDING_MODELS["bge-m3"]!;

    it("refuses an input longer than bge-m3 takes", () => {
        expect(isTooLongForModel(bgeM3, ["a".repeat(8000)])).toBe(false);
        expect(isTooLongForModel(bgeM3, ["short", "a".repeat(8001)])).toBe(true);
    });

    it("leaves a model without its own limit to the route's cap", () => {
        expect(isTooLongForModel(EMBEDDING_MODELS["text-embedding-3-small"]!, ["a".repeat(30_000)])).toBe(false);
    });
});
