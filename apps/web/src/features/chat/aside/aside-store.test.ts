import { beforeEach, describe, expect, it } from "vitest";

import { MAX_ASIDE_ENTRIES, useAsideStore } from "./aside-store";

describe("aside store", () => {
    beforeEach(() => {
        useAsideStore.setState({ byThread: {} });
    });

    it("keeps each thread's questions apart and updates one by id", () => {
        const { add, update } = useAsideStore.getState();

        add("t1", { id: "a", question: "What is X?", status: "pending" });
        add("t2", { id: "b", question: "What is Y?", status: "pending" });
        update("t1", "a", { answer: "X is X.", status: "answered", withThread: true });

        expect(useAsideStore.getState().byThread["t1"]).toStrictEqual([
            { answer: "X is X.", id: "a", question: "What is X?", status: "answered", withThread: true },
        ]);
        expect(useAsideStore.getState().byThread["t2"]?.[0]?.status).toBe("pending");
    });

    it("removes one question and leaves the rest", () => {
        const { add, remove } = useAsideStore.getState();

        add("t1", { id: "a", question: "q1", status: "answered" });
        add("t1", { id: "b", question: "q2", status: "answered" });
        remove("t1", "a");

        expect(useAsideStore.getState().byThread["t1"]?.map((entry) => entry.id)).toStrictEqual(["b"]);
    });

    it("drops the oldest questions past the cap, and a cleared thread loses them all", () => {
        const { add, clear } = useAsideStore.getState();

        for (let index = 0; index < MAX_ASIDE_ENTRIES + 3; index += 1) {
            add("t1", { id: String(index), question: `q${String(index)}`, status: "answered" });
        }

        const entries = useAsideStore.getState().byThread["t1"]!;

        expect(entries).toHaveLength(MAX_ASIDE_ENTRIES);
        expect(entries[0]?.id).toBe("3");

        clear("t1");
        expect(useAsideStore.getState().byThread["t1"]).toBeUndefined();
    });
});
