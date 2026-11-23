/**
 * Prompts wait per thread, in order, for the composer of their thread: a second one does not replace the first, and one
 * for another thread made in between stays for that thread.
 */
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setDraftBound, setRestoreAfterSend, useBoundDraftStore } from "@/features/chat/split/composer-drafts";

import { prefillComposer, prefillThreadOf, resetComposerPrefillForTests, useComposerPrefill, useComposerTakesPrefill } from "./composer-prefill";

beforeEach(() => {
    resetComposerPrefillForTests();
    useBoundDraftStore.setState({ owners: new Set<string>(), restoreAfterSendFor: undefined });
});

describe(useComposerPrefill, () => {
    it("hands a composer that mounts later every prompt made for its thread, in order, and leaves another thread's", () => {
        prefillComposer("thread-a", "Fix checks");
        prefillComposer("thread-b", "Resolve conflicts");
        prefillComposer("thread-a", "Address review");

        const takenByA = vi.fn();
        const { unmount } = renderHook(() => useComposerPrefill("thread-a", takenByA));

        expect(takenByA.mock.calls).toStrictEqual([["Fix checks"], ["Address review"]]);

        unmount();

        const takenByB = vi.fn();

        renderHook(() => useComposerPrefill("thread-b", takenByB));

        expect(takenByB.mock.calls).toStrictEqual([["Resolve conflicts"]]);
    });

    it("hands a mounted composer each later prompt for its thread once", () => {
        const taken = vi.fn();

        renderHook(() => useComposerPrefill("thread-c", taken));
        act(() => {
            prefillComposer("thread-c", "one");
            prefillComposer("thread-d", "not mine");
            prefillComposer("thread-c", "two");
        });

        expect(taken.mock.calls).toStrictEqual([["one"], ["two"]]);
    });

    it("queues the same prompt once however often it is requested before the composer takes it", () => {
        prefillComposer("thread-a", "prompt");
        prefillComposer("thread-a", "prompt");

        const taken = vi.fn();

        renderHook(() => useComposerPrefill("thread-a", taken));

        expect(taken.mock.calls).toStrictEqual([["prompt"]]);
    });

    it("takes nothing for a new chat", () => {
        const taken = vi.fn();

        prefillComposer("thread-e", "waits");
        renderHook(() => useComposerPrefill(undefined, taken));

        expect(taken).not.toHaveBeenCalled();
    });

    it("waits for the thread's stored draft to come back before the shared composer takes a prompt", () => {
        const taken = vi.fn();

        renderHook(() => useComposerPrefill("thread-a", taken, { awaitStoredDraft: true }));
        act(() => prefillComposer("thread-a", "prompt"));

        expect(taken).not.toHaveBeenCalled();

        act(() => setDraftBound("thread-a", true));

        expect(taken.mock.calls).toStrictEqual([["prompt"]]);
    });

    it("holds a prompt only for the thread whose draft a send brings back, and hands it over once that restore ends", () => {
        const takenByA = vi.fn();
        const takenByB = vi.fn();

        act(() => {
            setDraftBound("thread-a", true);
            setDraftBound("thread-b", true);
            setRestoreAfterSend("thread-a");
        });
        renderHook(() => useComposerPrefill("thread-a", takenByA, { awaitStoredDraft: true }));
        renderHook(() => useComposerPrefill("thread-b", takenByB, { awaitStoredDraft: true }));
        act(() => {
            prefillComposer("thread-a", "catch up a");
            prefillComposer("thread-b", "catch up b");
        });

        // Thread a's send is still bringing its draft back; thread b's composer does not wait for it.
        expect(takenByA).not.toHaveBeenCalled();
        expect(takenByB.mock.calls).toStrictEqual([["catch up b"]]);

        act(() => setRestoreAfterSend(undefined));

        expect(takenByA.mock.calls).toStrictEqual([["catch up a"]]);
    });

    it("tells a control whether its thread has a composer that takes prompts", () => {
        const { rerender, result } = renderHook(() => useComposerTakesPrefill("thread-a"));

        expect(result.current).toBe(false);

        const { unmount } = renderHook(() => useComposerPrefill("thread-a", vi.fn()));

        rerender();

        expect(result.current).toBe(true);

        unmount();
        rerender();

        expect(result.current).toBe(false);
    });
});

describe(prefillThreadOf, () => {
    it("takes prompts for a thread whose read is loading or ready", () => {
        expect(prefillThreadOf("thread-a", false, "loading")).toBe("thread-a");
        expect(prefillThreadOf("thread-a", false, "ready")).toBe("thread-a");
        expect(prefillThreadOf("thread-a", false, undefined)).toBe("thread-a");
    });

    it("takes none while the thread's read has failed, nor for the compact bar or a new chat", () => {
        expect(prefillThreadOf("thread-a", false, "failed")).toBeUndefined();
        expect(prefillThreadOf("thread-a", true, "ready")).toBeUndefined();
        expect(prefillThreadOf(undefined, false, "ready")).toBeUndefined();
    });
});
