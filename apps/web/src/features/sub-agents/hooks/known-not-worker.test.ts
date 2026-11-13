import { describe, expect, it } from "vitest";

import { isKnownNotWorker } from "./known-not-worker";

const answered = <T>(data: T) => {
    return { data, isSuccess: true };
};
const NOT_YET = { data: undefined, isSuccess: false };

describe(isKnownNotWorker, () => {
    it("knows only once the thread has answered: not while its read is out, nor when it failed with nothing kept", () => {
        expect(isKnownNotWorker(NOT_YET, NOT_YET)).toBe(false);
        expect(isKnownNotWorker(answered({ branchType: "subagent" }), NOT_YET)).toBe(false);
    });

    it("still knows after a refetch that failed, from the answer it kept", () => {
        const failedRefetch = <T>(data: T) => {
            return { data, isSuccess: false };
        };

        expect(isKnownNotWorker(failedRefetch(null), NOT_YET)).toBe(true);
        expect(isKnownNotWorker(failedRefetch({ branchType: "subagent" }), failedRefetch(null))).toBe(true);
        expect(isKnownNotWorker(failedRefetch({ branchType: "subagent" }), failedRefetch({ id: "worker" }))).toBe(false);
    });

    it("knows an ordinary chat, and a sub-agent's thread that answered it has no worker", () => {
        expect(isKnownNotWorker(answered(null), NOT_YET)).toBe(true);
        expect(isKnownNotWorker(answered({ branchType: "branch" }), NOT_YET)).toBe(true);
        expect(isKnownNotWorker(answered({ branchType: "subagent" }), answered(null))).toBe(true);
    });

    it("knows a worker's thread as one", () => {
        expect(isKnownNotWorker(answered({ branchType: "subagent" }), answered({ id: "worker" }))).toBe(false);
    });
});
