// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { useLayoutEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { usePasteGuard } from "./use-paste-guard";

const dismiss = vi.hoisted(() => vi.fn());

vi.mock("sonner", () => {
    return { toast: { dismiss } };
});

describe("usePasteGuard", () => {
    beforeEach(() => {
        dismiss.mockClear();
    });

    it("names the chat while mounted and follows a chat change", () => {
        const { rerender, result } = renderHook(({ id }) => usePasteGuard(id), { initialProps: { id: "chat-1" } });

        expect(result.current.getChatKey()).toBe("chat-1");

        rerender({ id: "chat-2" });

        expect(result.current.getChatKey()).toBe("chat-2");
    });

    it("names the new chat already in the commit of a chat change, before passive effects run", () => {
        const seen: (string | null | undefined)[] = [];
        const { rerender } = renderHook(
            ({ id }) => {
                const guard = usePasteGuard(id);

                // Runs in the same commit, after the guard's own layout effect: a paste resuming here must see the new chat.
                useLayoutEffect(() => {
                    seen.push(guard.getChatKey());
                });

                return guard;
            },
            { initialProps: { id: "chat-1" } },
        );

        rerender({ id: "chat-2" });

        expect(seen.at(-1)).toBe("chat-2");
    });

    it("names no chat once the composer unmounted, so a late upload failure writes nowhere", () => {
        const { result, unmount } = renderHook(() => usePasteGuard("chat-1"));

        unmount();

        expect(result.current.getChatKey()).toBeNull();
        expect(result.current.isMounted()).toBe(false);
    });

    it("dismisses the toasts it showed when the composer unmounts", () => {
        const { result, unmount } = renderHook(() => usePasteGuard("chat-1"));

        result.current.trackToast("t1");
        unmount();

        expect(dismiss).toHaveBeenCalledWith("t1");
    });
});
