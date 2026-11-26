import { describe, expect, it, vi } from "vitest";

import { createReturnedPrompts } from "./returned-prompts";

describe(createReturnedPrompts, () => {
    it("keeps each chat's prompts apart, oldest first", () => {
        const store = createReturnedPrompts();

        store.add("t1", { clientMessageId: "a", prompt: "first", reason: "x" });
        store.add("t1", { clientMessageId: "b", prompt: "second", reason: "x" });
        store.add("t2", { clientMessageId: "c", prompt: "elsewhere", reason: "x" });

        expect(store.list("t1").map((item) => item.prompt)).toStrictEqual(["first", "second"]);
        expect(store.list("t2").map((item) => item.prompt)).toStrictEqual(["elsewhere"]);
        expect(store.list("t3")).toStrictEqual([]);
    });

    it("finds the item holding exactly a prompt, which a send of that text resends", () => {
        const store = createReturnedPrompts();

        store.add("t1", { clientMessageId: "a", prompt: "hello", reason: "x" });

        expect(store.withPrompt("t1", "hello")?.clientMessageId).toBe("a");
        expect(store.withPrompt("t1", "hello again")).toBeUndefined();
        expect(store.withPrompt("t2", "hello")).toBeUndefined();
    });

    it("updates an item in place, keeping its id and place", () => {
        const store = createReturnedPrompts();
        const firstId = store.add("t1", { clientMessageId: "a", prompt: "first", reason: "x" });

        store.add("t1", { clientMessageId: "b", prompt: "second", reason: "x" });
        store.update("t1", firstId, { clientMessageId: null, reason: "y" });

        expect(store.list("t1")).toStrictEqual([
            { clientMessageId: null, id: firstId, prompt: "first", reason: "y" },
            expect.objectContaining({ prompt: "second" }),
        ]);
    });

    it("removes one item, and forgets a chat left empty", () => {
        const store = createReturnedPrompts();
        const firstId = store.add("t1", { clientMessageId: "a", prompt: "first", reason: "x" });
        const secondId = store.add("t1", { clientMessageId: "b", prompt: "second", reason: "x" });

        store.remove("t1", firstId);
        expect(store.list("t1").map((item) => item.id)).toStrictEqual([secondId]);

        store.remove("t1", secondId);
        expect(store.list("t1")).toStrictEqual([]);
    });

    it("clears every chat at sign-out", () => {
        const store = createReturnedPrompts();

        store.add("t1", { clientMessageId: "a", prompt: "first", reason: "x" });
        store.add("new", { clientMessageId: null, prompt: "second", reason: "x" });
        store.clear();

        expect(store.list("t1")).toStrictEqual([]);
        expect(store.list("new")).toStrictEqual([]);
    });

    it("hands back the same array until a chat's items change, and tells its listeners when they do", () => {
        const store = createReturnedPrompts();
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        const before = store.list("t1");

        expect(store.list("t1")).toBe(before);

        store.add("t1", { clientMessageId: "a", prompt: "first", reason: "x" });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.list("t1")).not.toBe(before);

        unsubscribe();
        store.add("t1", { clientMessageId: "b", prompt: "second", reason: "x" });
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
