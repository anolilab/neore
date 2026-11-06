import { describe, expect, it } from "vitest";

import { isReopenOn, isSavedThread, parseLastThread, reopenValue, threadToReopen } from "./last-thread";

describe("reopen setting", () => {
    it("is on when nothing has been stored", () => {
        expect(isReopenOn(null)).toBe(true);
    });

    it("is off only for the stored off value", () => {
        expect(isReopenOn("on")).toBe(true);
        expect(isReopenOn(reopenValue(false))).toBe(false);
        expect(isReopenOn(reopenValue(true))).toBe(true);
    });
});

describe("parseLastThread", () => {
    it("reads a saved chat", () => {
        expect(parseLastThread(JSON.stringify({ threadId: "t-1", userId: "u-1" }))).toEqual({ threadId: "t-1", userId: "u-1" });
    });

    it("reads nothing when nothing is saved", () => {
        expect(parseLastThread(null)).toBeUndefined();
    });

    it("treats a damaged or incomplete value as no chat", () => {
        expect(parseLastThread("{not json")).toBeUndefined();
        expect(parseLastThread(JSON.stringify({ threadId: "t-1" }))).toBeUndefined();
        expect(parseLastThread(JSON.stringify({ threadId: "", userId: "u-1" }))).toBeUndefined();
        expect(parseLastThread(JSON.stringify(["t-1"]))).toBeUndefined();
    });
});

describe("threadToReopen", () => {
    const saved = { threadId: "t-1", userId: "u-1" };

    it("reopens the saved chat for the account that viewed it", () => {
        expect(threadToReopen({ isOn: true, last: saved, userId: "u-1" })).toBe("t-1");
    });

    it("opens nothing when the setting is off", () => {
        expect(threadToReopen({ isOn: false, last: saved, userId: "u-1" })).toBeUndefined();
    });

    it("never opens another account's chat", () => {
        expect(threadToReopen({ isOn: true, last: saved, userId: "u-2" })).toBeUndefined();
    });

    it("opens nothing when no chat was viewed", () => {
        expect(threadToReopen({ isOn: true, last: undefined, userId: "u-1" })).toBeUndefined();
    });

    it("relaunch opens the last thread viewed on this device, from the stored values", () => {
        const stored = JSON.stringify({ threadId: "t-9", userId: "u-1" });

        expect(threadToReopen({ isOn: isReopenOn(null), last: parseLastThread(stored), userId: "u-1" })).toBe("t-9");
    });
});

describe("isSavedThread", () => {
    const saved = { threadId: "t-1", userId: "u-1" };

    it("is true only for the same chat of the same account", () => {
        expect(isSavedThread(saved, { threadId: "t-1", userId: "u-1" })).toBe(true);
        expect(isSavedThread(saved, { threadId: "t-2", userId: "u-1" })).toBe(false);
        expect(isSavedThread(saved, { threadId: "t-1", userId: "u-2" })).toBe(false);
        expect(isSavedThread(undefined, { threadId: "t-1", userId: "u-1" })).toBe(false);
    });
});
