import { describe, expect, it } from "vitest";

import { decodeVector, embed, encodeVector } from "./embed";

describe("stored vectors", () => {
    it("round-trips a vector through its stored text", () => {
        const vector = [0.25, -1, 0, 3.5];

        expect(decodeVector(encodeVector(vector))).toEqual(vector);
    });

    it("is the declared embedder: the sync hands it the stored text and gets the vector back, with no model call", async () => {
        const vector = Array.from({ length: 8 }, (_, index) => index / 8);

        await expect(embed(encodeVector(vector))).resolves.toEqual(vector);
    });

    it("refuses a stored text that is not an array of finite numbers, so a corrupt row fails its write", () => {
        expect(() => decodeVector("null")).toThrow("finite numbers");
        expect(() => decodeVector('[1,"x"]')).toThrow("finite numbers");
        expect(() => decodeVector("{}")).toThrow("finite numbers");
        expect(() => decodeVector(encodeVector([NaN]))).toThrow("finite numbers");
    });
});
