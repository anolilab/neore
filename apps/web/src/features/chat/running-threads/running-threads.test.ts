import { describe, expect, it } from "vitest";

import { runningThreads } from "./running-threads";

describe("runningThreads", () => {
    it("keeps only threads whose status is running, newest start first", () => {
        const threads = [
            { _id: "a", status: "active", updatedAt: 500 },
            { _id: "b", status: "running", updatedAt: 100 },
            { _id: "c", status: "running", updatedAt: 300 },
            { _id: "d", status: "error", updatedAt: 900 },
            { _id: "e", status: "running", updatedAt: 200 },
        ];

        expect(runningThreads(threads).map((thread) => thread._id)).toEqual(["c", "e", "b"]);
    });

    it("returns an empty list when nothing is running", () => {
        expect(runningThreads([{ _id: "a", status: "active" }, { _id: "b" }])).toEqual([]);
    });

    it("does not mutate its input", () => {
        const threads = [
            { _id: "a", status: "running", updatedAt: 1 },
            { _id: "b", status: "running", updatedAt: 2 },
        ];

        runningThreads(threads);

        expect(threads.map((thread) => thread._id)).toEqual(["a", "b"]);
    });
});
