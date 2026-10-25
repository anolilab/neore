import { beforeEach, describe, expect, it } from "vitest";

import { useModelStore } from "./model-store";

beforeEach(() => {
    useModelStore.getState().resetForNewThread(undefined);
    useModelStore.getState().setPendingSettings(undefined);
});

describe("a composer effort and the thread it was set on", () => {
    it("is dropped when another thread loads, and the other pending settings stay", () => {
        useModelStore.getState().loadThreadData({}, "thread-a");
        useModelStore.getState().setPendingSettings({ language: "de", reasoningEffort: 75 });

        useModelStore.getState().loadThreadData({}, "thread-b");

        expect(useModelStore.getState().pendingSettings).toStrictEqual({ language: "de" });
        expect(useModelStore.getState().getPendingSettings()).toStrictEqual({ language: "de" });
    });

    it("leaves no pending settings when the effort was all there was", () => {
        useModelStore.getState().loadThreadData({}, "thread-a");
        useModelStore.getState().setPendingSettings({ reasoningEffort: 25 });

        useModelStore.getState().loadThreadData({}, "thread-b");

        expect(useModelStore.getState().pendingSettings).toBeUndefined();
    });

    it("is kept when the same thread loads again", () => {
        useModelStore.getState().loadThreadData({}, "thread-a");
        useModelStore.getState().setPendingSettings({ reasoningEffort: 75 });

        useModelStore.getState().loadThreadData({}, "thread-a");

        expect(useModelStore.getState().pendingSettings?.reasoningEffort).toBe(75);
    });
});
