/**
 * Prompts wait per thread, in order, for the composer of their thread: a second one does not replace the first, and one
 * for another thread made in between stays for that thread.
 */
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { prefillComposer, useComposerPrefill } from "./composer-prefill";

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

    it("takes nothing for a new chat", () => {
        const taken = vi.fn();

        prefillComposer("thread-e", "waits");
        renderHook(() => useComposerPrefill(undefined, taken));

        expect(taken).not.toHaveBeenCalled();
    });
});
