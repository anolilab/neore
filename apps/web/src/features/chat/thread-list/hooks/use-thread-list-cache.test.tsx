import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearThreadListCache, releaseThreadListWrites, writeThreadListCache } from "../lib/thread-list-cache";
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
        releaseThreadListWrites();
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

    it("never writes the previous account's query result under the new user", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        const stale = { ...list("alice", "Alice chat"), threads: { page: [{ _id: "t1", title: "Alice chat" }] } };
        const { rerender } = renderHook(({ data }) => usePersistThreadList(data, false), { initialProps: { data: stale as unknown } });

        setToken(jwtFor("bob"));
        rerender({ data: stale });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage.getItem("neore-thread-list:v1:bob")).toBeNull();

        rerender({ data: { ...stale, threads: { page: [{ _id: "t2", title: "Bob chat" }] } } });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage.getItem("neore-thread-list:v1:bob")).toContain("Bob chat");
    });

    it("stores nothing for a push that arrives while a sign-out is under way, until the next sign-in", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        const { rerender } = renderHook(({ owner, title }) => usePersistThreadList(list(owner, title), false), {
            initialProps: { owner: "alice", title: "T" },
        });

        clearThreadListCache();
        rerender({ owner: "alice", title: "Streaming reply push" });
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

    it("keeps refusing writes when the sidebar remounts during a sign-out", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        const { unmount } = renderHook(() => usePersistThreadList(list("alice", "T"), false));

        clearThreadListCache();
        unmount();

        renderHook(() => usePersistThreadList(list("alice", "After remount"), false));
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(0);
    });

    it("resumes persisting when a removal in another tab was not a sign-out", () => {
        vi.useFakeTimers();
        auth.token = jwtFor("alice");

        const { rerender } = renderHook(({ title }) => usePersistThreadList(list("alice", title), false), {
            initialProps: { title: "T" },
        });

        act(() => {
            globalThis.dispatchEvent(new StorageEvent("storage", { key: "neore-thread-list:v1:alice", newValue: null, oldValue: "{}" }));
            // A full clear and another user's removal are not this user's sign-out.
            globalThis.dispatchEvent(new StorageEvent("storage", { key: null, newValue: null }));
            globalThis.dispatchEvent(new StorageEvent("storage", { key: "neore-thread-list:v1:bob", newValue: null }));
        });
        // The session lives on: a refreshed token for the same user lifts the hold.
        setToken(jwtFor("alice"));
        rerender({ title: "Later push" });
        act(() => {
            vi.advanceTimersByTime(2000);
        });
        expect(localStorage).toHaveLength(1);
    });

    it("ignores a storage event for an unrelated key, another user's key or a write by another tab", () => {
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
