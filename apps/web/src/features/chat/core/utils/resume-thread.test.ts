import { describe, expect, it } from "vitest";

import { pickResumeThreadId } from "./resume-thread";

const thread = (_id: string, _creationTime: number, extra: { deleted?: boolean; status?: string } = {}) => {
    return { _creationTime, _id, status: "active", ...extra };
};

describe("pickResumeThreadId", () => {
    it("picks the newest thread", () => {
        expect(pickResumeThreadId([thread("a", 1), thread("b", 3), thread("c", 2)], new Set())).toBe("b");
    });

    it("skips deleted, archived and branch threads", () => {
        const threads = [thread("a", 1), thread("b", 4, { deleted: true }), thread("c", 3, { status: "archived" }), thread("d", 2)];

        expect(pickResumeThreadId(threads, new Set(["d"]))).toBe("a");
    });

    it("returns undefined when nothing qualifies", () => {
        expect(pickResumeThreadId(undefined, new Set())).toBeUndefined();
        expect(pickResumeThreadId([], new Set())).toBeUndefined();
    });
});
