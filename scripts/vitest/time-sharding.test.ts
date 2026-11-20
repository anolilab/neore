import { describe, expect, it } from "vitest";

import { partition, weigher } from "./time-sharding";

const id = (name: string): string => name;

describe(partition, () => {
    const timings = { a: 900, b: 500, c: 400, d: 300, e: 200, f: 100 };
    const weigh = weigher(timings);
    const files = Object.keys(timings);

    it("runs every file exactly once across the shards", () => {
        expect.assertions(2);

        const shards = partition(files, 3, weigh, id);

        expect(shards.flat().toSorted()).toStrictEqual(files.toSorted());
        expect(new Set(shards.flat()).size).toBe(files.length);
    });

    it("gives every shard the same split whatever order the files arrive in", () => {
        expect.assertions(1);

        expect(partition(files.toReversed(), 3, weigh, id)).toStrictEqual(partition(files, 3, weigh, id));
    });

    it("balances the shards by recorded time, not by file count", () => {
        expect.assertions(1);

        const loads = partition(files, 3, weigh, id).map((shard) => shard.reduce((sum, file) => sum + weigh(file), 0));

        expect(loads).toStrictEqual([900, 800, 700]);
    });

    it("weighs an unrecorded file as the average of the recorded ones", () => {
        expect.assertions(1);

        expect(weigher({ a: 100, b: 300 })("new.test.ts")).toBe(200);
    });
});
