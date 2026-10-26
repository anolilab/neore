import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearThreadListCache, writeThreadListCache } from "../lib/thread-list-cache";
import { usePersistThreadList, useThreadListPlaceholder } from "./use-thread-list-cache";

const auth: { token: string | null } = { token: null };
const listeners = new Set<() => void>();
const client = {
    getAuthToken: () => auth.token,
    onAuthTokenChange: (listener: () => void) => {
        listeners.add(listener);

        return () => listeners.delete(listener);
    },
};

vi.mock("@/lib/lunora/crpc", () => {
    return { useCRPCClient: () => client };
});

const jwtFor = (sub: string) => `h.${btoa(JSON.stringify({ sub }))}.s`;
const list = (userId: string, title: string) => {
    return {
        pinnedThreads: [],
        relationships: [],
        tags: [],
        temporaryThreads: { page: [] },
        threadOrders: [],
        threads: { page: [{ _id: "t1", title, userId }] },
    };
};

const setToken = (next: string | null) => {
    auth.token = next;
    act(() => {
        for (const listener of listeners) {
            listener();
        }
    });
};

describe("thread list cache hooks", () => {
    beforeEach(() => {
        localStorage.clear();
        auth.token = null;
        vi.useRealTimers();
    });

    it("gives no placeholder without a user, then only the signed-in user's list", () => {
        writeThreadListCache("alice", list("alice", "Alice chat"));
        writeThreadListCache("bob", list("bob", "Bob chat"));

        const { result } = renderHook(() => useThreadListPlaceholder());

        expect(result.current).toBeUndefined();

        setToken(jwtFor("bob"));
        expect(result.current?.threads.page[0]?.title).toBe("Bob chat");

        setToken(jwtFor("carol"));
        expect(result.current).toBeUndefined();
    });

    it("never turns an unreadable token into a storage key", () => {
        const setItem = vi.spyOn(Storage.prototype, "setItem");

        auth.token = "opaque-bearer-without-claims";
        renderHook(() => usePersistThreadList(list("x", "T"), false));

        expect(setItem).not.toHaveBeenCalled();
        expect(Object.keys(localStorage).join("")).not.toContain("opaque");
    });

    it("persists fetched data, and never a placeholder", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        const { rerender } = renderHook(({ placeholder }) => usePersistThreadList(list("alice", "T"), placeholder), { initialProps: { placeholder: true } });

        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(0);

        rerender({ placeholder: false });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(1);
    });

    it("drops a write that was waiting when the cache was cleared", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        renderHook(() => usePersistThreadList(list("alice", "T"), false));
        clearThreadListCache();

        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(0);
    });

    it("stops persisting once another tab clears the stored lists", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        const { rerender } = renderHook(({ owner, title }) => usePersistThreadList(list(owner, title), false), {
            initialProps: { owner: "alice", title: "T" },
        });

        act(() => {
            globalThis.dispatchEvent(new StorageEvent("storage", { key: "neore-thread-list:v1:alice", newValue: null, oldValue: "{}" }));
        });
        rerender({ owner: "alice", title: "Later push" });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(0);

        setToken(jwtFor("bob"));
        rerender({ owner: "bob", title: "Bob push" });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(1);
    });

    it("ignores a storage event for an unrelated key or a write by another tab", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        renderHook(() => usePersistThreadList(list("alice", "T"), false));

        act(() => {
            globalThis.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: null }));
            globalThis.dispatchEvent(new StorageEvent("storage", { key: "neore-thread-list:v1:alice", newValue: "{}" }));
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(1);
    });

    it("skips a write when the session user changed before it fired", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        renderHook(() => usePersistThreadList(list("alice", "T"), false));
        auth.token = jwtFor("bob");

        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(0);
    });
});
