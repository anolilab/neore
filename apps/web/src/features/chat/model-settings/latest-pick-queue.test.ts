import { describe, expect, it } from "vitest";

import { createLatestPickQueue } from "./latest-pick-queue";

describe("createLatestPickQueue", () => {
    it("starts a call only after the earlier one settled, so the server sees the picks in order", async () => {
        const queue = createLatestPickQueue();
        let finishFirst: (value: string) => void = () => {};
        // The tsconfig lib predates `Promise.withResolvers`.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        const first = new Promise<string>((resolve) => {
            finishFirst = resolve;
        });
        const started: string[] = [];

        const a = queue.run(async () => {
            started.push("A");

            return await first;
        });
        const b = queue.run(async () => {
            started.push("B");

            return "B";
        });

        await Promise.resolve();
        expect(started).toStrictEqual(["A"]);

        finishFirst("A");
        await a.result;
        await b.result;

        expect(started).toStrictEqual(["A", "B"]);
    });

    it("reports only the newest pick as latest, however late an earlier answer lands", async () => {
        const queue = createLatestPickQueue();
        const a = queue.run(async () => "A");
        const b = queue.run(async () => "B");

        await a.result;

        expect(a.isLatest()).toBe(false);
        expect(b.isLatest()).toBe(true);
    });

    it("does not let a failed pick block the next one", async () => {
        const queue = createLatestPickQueue();
        const a = queue.run(async () => {
            throw new Error("refused");
        });
        const b = queue.run(async () => "B");

        await expect(a.result).rejects.toThrow("refused");
        await expect(b.result).resolves.toBe("B");
    });
});
