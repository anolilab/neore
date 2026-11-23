import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setDraftBound, useBoundDraftStore } from "@/features/chat/split/composer-drafts";

import { prefillComposer, resetComposerPrefillForTests, useComposerPrefill } from "./composer-prefill";

beforeEach(() => {
    resetComposerPrefillForTests();
    useBoundDraftStore.setState({ owners: new Set<string>() });
});

const mount = (threadId: string, apply: (text: string) => void) => renderHook(() => useComposerPrefill(threadId, apply));

describe(useComposerPrefill, () => {
    it("keeps a request for each thread until its own composer takes it", () => {
        prefillComposer("thread-a", "prompt a");
        prefillComposer("thread-b", "prompt b");
        setDraftBound("thread-a", true);
        setDraftBound("thread-b", true);

        const applyA = vi.fn();
        const applyB = vi.fn();

        mount("thread-a", applyA);
        mount("thread-b", applyB);

        expect(applyA.mock.calls).toEqual([["prompt a"]]);
        expect(applyB.mock.calls).toEqual([["prompt b"]]);
    });

    it("waits for the thread's stored draft to come back before it fills the composer", () => {
        const apply = vi.fn();

        mount("thread-a", apply);
        act(() => prefillComposer("thread-a", "prompt"));

        expect(apply).not.toHaveBeenCalled();

        act(() => setDraftBound("thread-a", true));

        expect(apply.mock.calls).toEqual([["prompt"]]);
    });

    it("queues the same prompt once however often it is requested before the composer takes it", () => {
        prefillComposer("thread-a", "prompt");
        prefillComposer("thread-a", "prompt");
        setDraftBound("thread-a", true);

        const apply = vi.fn();

        mount("thread-a", apply);

        expect(apply.mock.calls).toEqual([["prompt"]]);
    });
});

describe("a composer that goes away", () => {
    it("drops what was still waiting for its draft, instead of filling the chat on a later visit", () => {
        const { unmount } = mount("thread-a", vi.fn());

        act(() => prefillComposer("thread-a", "prompt"));
        unmount();
        setDraftBound("thread-a", true);

        const apply = vi.fn();

        mount("thread-a", apply);

        expect(apply).not.toHaveBeenCalled();
    });
});
