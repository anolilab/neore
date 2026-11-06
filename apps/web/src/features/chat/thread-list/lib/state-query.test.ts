import { describe, expect, it } from "vitest";

import type { BranchNode } from "../types";
import { threadStateOf } from "./derived-sections";
import { compareByStateRank, parseStateQuery } from "./state-query";

const NOW = 1_000_000;

const row = (threadId: string, extra: Partial<BranchNode> = {}): BranchNode => {
    return {
        branchPoint: 0,
        branchType: "branch",
        children: [],
        createdAt: 1,
        depth: 0,
        lastReplyAt: 500,
        scheduled: false,
        status: "active",
        threadId,
        title: threadId,
        ...extra,
    };
};

describe("parseStateQuery", () => {
    it("reads a leading state tag and leaves the rest as the title search", () => {
        expect(parseStateQuery("#needs-you login")).toEqual({ state: "needsYou", text: "login" });
    });

    it("accepts a tag on its own, in any case", () => {
        expect(parseStateQuery("#Working")).toEqual({ state: "working", text: "" });
        expect(parseStateQuery("  #idle  ")).toEqual({ state: "idle", text: "" });
        expect(parseStateQuery("#snoozed")).toEqual({ state: "snoozed", text: "" });
    });

    it("treats an unknown tag as ordinary text, so a title that starts with # still matches", () => {
        expect(parseStateQuery("#42 release notes")).toEqual({ state: undefined, text: "#42 release notes" });
    });

    it("treats a query with no tag as plain text", () => {
        expect(parseStateQuery("  plain search ")).toEqual({ state: undefined, text: "plain search" });
    });
});

describe("threadStateOf", () => {
    it("#working lists only running threads", () => {
        const threads = [row("running", { status: "running" }), row("idle"), row("waiting", { awaitingInput: "approval" })];
        const working = threads.filter((thread) => threadStateOf(thread, NOW) === parseStateQuery("#working").state);

        expect(working.map((thread) => thread.threadId)).toEqual(["running"]);
    });

    it("classifies a finished thread with nothing pending as idle", () => {
        expect(threadStateOf(row("a"), NOW)).toBe("idle");
    });

    it("classifies a thread waiting for an approval as needs you", () => {
        expect(threadStateOf(row("a", { awaitingInput: "approval" }), NOW)).toBe("needsYou");
    });

    it("classifies a snoozed thread as snoozed, even while its run is going", () => {
        expect(threadStateOf(row("a", { snoozedUntil: NOW + 1, status: "running" }), NOW)).toBe("snoozed");
    });

    it("classifies an archived thread as other, even while it still waits or is snoozed", () => {
        expect(threadStateOf(row("a", { awaitingInput: "approval", snoozedUntil: NOW + 1, status: "archived" }), NOW)).toBe("other");
    });

    it("classifies a thread that never replied as other, so no state tag lists it", () => {
        expect(threadStateOf(row("a", { lastReplyAt: undefined }), NOW)).toBe("other");
    });
});

describe("compareByStateRank", () => {
    it("puts working threads first, then those waiting for the owner, keeping order within a rank", () => {
        const sorted = [
            { id: "idle-1", state: "idle" as const },
            { id: "needs", state: "needsYou" as const },
            { id: "run-1", state: "working" as const },
            { id: "idle-2", state: "idle" as const },
            { id: "run-2", state: "working" as const },
        ].toSorted(compareByStateRank);

        expect(sorted.map((item) => item.id)).toEqual(["run-1", "run-2", "needs", "idle-1", "idle-2"]);
    });
});
