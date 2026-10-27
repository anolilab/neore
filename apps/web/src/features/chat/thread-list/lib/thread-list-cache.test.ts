import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    clearThreadListCache,
    clearThreadListCacheFor,
    getThreadListStorage,
    projectThreadList,
    readThreadListCache,
    toThreadListData,
    writeThreadListCache,
} from "./thread-list-cache";

const SIGNED_URL = "https://files.example.com/agent-files/abc?signature=deadbeef&expires=1";

const listFor = (userId: string, title = "First") => {
    return {
        pinnedThreads: [{ _id: "t1", publicAccessToken: "pin-secret", title }],
        relationships: [{ _id: "r1", _creationTime: 1, branchType: "branch", createdAt: 3, parentThreadId: "t1", threadId: "t2" }],
        tags: [{ _id: "g1", color: "red", name: "Work", order: 0, userId }],
        temporaryThreads: { continueCursor: "c", isDone: true, page: [] },
        threadOrders: [{ _id: "t1", order: 2, summary: "no" }],
        threads: {
            continueCursor: "c",
            isDone: true,
            page: [
                {
                    _creationTime: 1,
                    _id: "t1",
                    avatarUrl: SIGNED_URL,
                    createdAt: 2,
                    customSystemPrompt: "secret prompt",
                    lastMessage: { parts: [{ type: "file", url: SIGNED_URL }] },
                    messages: [{ text: "hello" }],
                    organizationId: "org",
                    publicAccessToken: "share-token",
                    relevantMessages: [{ text: "match" }],
                    status: "active",
                    summary: "a summary",
                    tagIds: ["g1"],
                    title,
                    updatedAt: 4,
                    userId,
                },
            ],
        },
    };
};

describe("thread list cache", () => {
    beforeEach(() => {
        localStorage.clear();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    describe("keying", () => {
        it("never shows one user's list to another", () => {
            writeThreadListCache("alice", listFor("alice", "Alice chat"));

            expect(readThreadListCache("bob")).toBeUndefined();
            expect(readThreadListCache("alice")?.threads[0]?.title).toBe("Alice chat");
        });

        it("reads and writes nothing without a user", () => {
            const setItem = vi.spyOn(Storage.prototype, "setItem");
            const getItem = vi.spyOn(Storage.prototype, "getItem");

            writeThreadListCache(undefined, listFor("alice"));

            expect(readThreadListCache(undefined)).toBeUndefined();
            expect(setItem).not.toHaveBeenCalled();
            expect(getItem).not.toHaveBeenCalled();
        });

        it("refuses a list that holds another user's rows", () => {
            writeThreadListCache("bob", listFor("alice"));

            expect(localStorage).toHaveLength(0);
        });

        it("rejects an entry whose recorded owner differs from its key", () => {
            writeThreadListCache("alice", listFor("alice"));
            const [key] = Object.keys(localStorage);
            const entry = JSON.parse(localStorage.getItem(key as string) as string);

            localStorage.setItem(key as string, JSON.stringify({ ...entry, userId: "bob" }));

            expect(readThreadListCache("alice")).toBeUndefined();
            expect(localStorage).toHaveLength(0);
        });
    });

    describe("clearing", () => {
        it("removes every user's list and leaves other keys alone", () => {
            writeThreadListCache("alice", listFor("alice"));
            writeThreadListCache("bob", listFor("bob"));
            localStorage.setItem("neore-collapsed-groups", '["archived"]');

            clearThreadListCache();

            expect(readThreadListCache("alice")).toBeUndefined();
            expect(readThreadListCache("bob")).toBeUndefined();
            expect(localStorage.getItem("neore-collapsed-groups")).toBe('["archived"]');
            expect(localStorage).toHaveLength(1);
        });

        it("removes only the named user's list", () => {
            writeThreadListCache("alice", listFor("alice"));
            writeThreadListCache("bob", listFor("bob"));

            clearThreadListCacheFor("bob");

            expect(readThreadListCache("bob")).toBeUndefined();
            expect(readThreadListCache("alice")).toBeDefined();
            expect(() => clearThreadListCacheFor("bob", undefined)).not.toThrow();
        });
    });

    it("stores no title for a locked chat", () => {
        const list = listFor("alice");

        list.threads.page.push({ ...list.threads.page[0], _id: "t9", lockedAt: 5, title: "Private" } as never);
        writeThreadListCache("alice", list);

        const rows = readThreadListCache("alice")?.threads ?? [];

        expect(rows.find((row) => row._id === "t9")).toMatchObject({ lockedAt: 5 });
        expect(rows.find((row) => row._id === "t9")).not.toHaveProperty("title");
        expect(rows.find((row) => row._id === "t1")).toHaveProperty("title", "First");
        expect(localStorage.getItem(Object.keys(localStorage)[0] as string)).not.toContain("Private");
    });

    describe("failure handling", () => {
        const seed = () => {
            writeThreadListCache("alice", listFor("alice"));

            return Object.keys(localStorage)[0] as string;
        };

        it("falls back to the network on corrupt JSON and drops the entry", () => {
            const key = seed();

            localStorage.setItem(key, "{not json");

            expect(readThreadListCache("alice")).toBeUndefined();
        });

        it.each([
            ["a wrong version", { v: 99 }],
            ["a malformed body", { data: { threads: "nope" } }],
            ["a non-object entry", "text"],
        ])("treats %s as no cache and removes it", (_name, patch) => {
            const key = seed();
            const entry = JSON.parse(localStorage.getItem(key) as string);

            localStorage.setItem(key, JSON.stringify(typeof patch === "string" ? patch : { ...entry, ...patch }));

            expect(readThreadListCache("alice")).toBeUndefined();
            expect(localStorage.getItem(key)).toBeNull();
        });

        it.each([
            ["an object-valued thread title", { threads: { title: { placeholder: true } } }],
            ["a thread without an id", { threads: { _id: undefined } }],
            ["a thread with an unknown field", { threads: { messages: "x" } }],
            ["a numeric tag name", { tags: { name: 1 } }],
            ["a non-string tag id list", { threads: { tagIds: [1] } }],
        ])("drops an entry with %s", (_name, patch) => {
            const key = seed();
            const entry = JSON.parse(localStorage.getItem(key) as string);

            for (const [list, fields] of Object.entries(patch)) {
                entry.data[list][0] = { ...entry.data[list][0], ...fields };
            }

            localStorage.setItem(key, JSON.stringify(entry));

            expect(readThreadListCache("alice")).toBeUndefined();
            expect(localStorage.getItem(key)).toBeNull();
        });

        it("swallows a quota error on write", () => {
            vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
                throw new DOMException("full", "QuotaExceededError");
            });

            expect(() => writeThreadListCache("alice", listFor("alice"))).not.toThrow();
        });

        it("swallows a throwing storage on read and clear", () => {
            const broken = {
                getItem: () => {
                    throw new Error("denied");
                },
                key: () => {
                    throw new Error("denied");
                },
                length: 1,
                removeItem: () => {
                    throw new Error("denied");
                },
                setItem: () => {
                    throw new Error("denied");
                },
            } as unknown as Storage;

            expect(readThreadListCache("alice", broken)).toBeUndefined();
            expect(() => writeThreadListCache("alice", listFor("alice"), broken)).not.toThrow();
            expect(() => clearThreadListCache(broken)).not.toThrow();
        });

        it("reports no storage when the browser denies access to it", () => {
            vi.spyOn(globalThis, "localStorage", "get").mockImplementation(() => {
                throw new DOMException("denied", "SecurityError");
            });

            expect(getThreadListStorage()).toBeUndefined();
            expect(readThreadListCache("alice")).toBeUndefined();
            expect(() => clearThreadListCache()).not.toThrow();
        });

        it("ignores data that is not a thread list result", () => {
            expect(projectThreadList(undefined, "alice")).toBeUndefined();
            expect(projectThreadList({ threads: {} }, "alice")).toBeUndefined();
        });
    });

    describe("what is stored", () => {
        it("keeps only the sidebar's fields", () => {
            writeThreadListCache("alice", listFor("alice"));
            const stored = readThreadListCache("alice");

            expect(Object.keys(stored?.threads[0] ?? {}).toSorted((a, b) => a.localeCompare(b))).toEqual([
                "_creationTime",
                "_id",
                "createdAt",
                "status",
                "tagIds",
                "title",
                "updatedAt",
            ]);
            expect(stored?.pinnedThreads).toEqual([{ _id: "t1" }]);
            expect(stored?.threadOrders).toEqual([{ _id: "t1", order: 2 }]);
            expect(stored?.relationships).toEqual([{ branchType: "branch", createdAt: 3, parentThreadId: "t1", threadId: "t2" }]);
            expect(stored?.tags).toEqual([{ _id: "g1", color: "red", name: "Work", order: 0 }]);
        });

        it("writes no messages, share tokens, prompts, summaries or signed URLs", () => {
            writeThreadListCache("alice", listFor("alice"));
            const raw = Object.values(localStorage).join("");

            for (const forbidden of [
                "messages",
                "lastMessage",
                "relevantMessages",
                "publicAccessToken",
                "share-token",
                "secret prompt",
                "a summary",
                "signature=",
                "files.example.com",
            ]) {
                expect(raw).not.toContain(forbidden);
            }
        });

        it("rebuilds the query result shape for the sidebar", () => {
            writeThreadListCache("alice", listFor("alice"));
            const data = toThreadListData(readThreadListCache("alice") as NonNullable<ReturnType<typeof readThreadListCache>>);

            expect(data.threads.page.map((thread) => thread._id)).toEqual(["t1"]);
            expect(data.temporaryThreads.page).toEqual([]);
        });
    });
});
