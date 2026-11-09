import { beforeEach, describe, expect, it } from "vitest";

import { clearComposerDrafts, draftGeneration, peekParkedModelState, peekWorkerDraft, saveParkedModelState, saveWorkerDraft } from "./composer-drafts";

beforeEach(() => {
    clearComposerDrafts();
});

describe("clearing the parked state of a session (#5, #7)", () => {
    it("drops the parked model choices and the worker drafts, and moves the generation on", () => {
        saveParkedModelState("thread-a", { userChangedMode: false, userChangedModel: false });
        saveWorkerDraft("worker-1", "half a message");

        const before = draftGeneration();

        clearComposerDrafts();

        expect(peekParkedModelState("thread-a")).toBeUndefined();
        expect(peekWorkerDraft("worker-1")).toBeUndefined();
        expect(draftGeneration()).toBe(before + 1);
    });
});

describe("worker drafts (#11)", () => {
    it("keeps the text of a worker until it is emptied", () => {
        saveWorkerDraft("worker-1", "half a message");

        expect(peekWorkerDraft("worker-1")).toBe("half a message");

        saveWorkerDraft("worker-1", "");

        expect(peekWorkerDraft("worker-1")).toBeUndefined();
    });
});
