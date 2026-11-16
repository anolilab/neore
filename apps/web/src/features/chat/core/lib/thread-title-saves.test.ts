import { describe, expect, it, vi } from "vitest";

import { beginTitleSave, queueTitleWrite, settleTitleSave, titleOnScreen, titleSaveRevision } from "./thread-title-saves";

// The module keeps its state for the whole run, so every case gets a thread of its own.
const cases = { count: 0 };
const newThread = (): string => {
    cases.count += 1;

    return `thread-${cases.count}`;
};

describe("title saves from the header and the list", () => {
    it("keeps a list rename that succeeded after a header save when the header save then fails", () => {
        const thread = newThread();
        const header = beginTitleSave(thread, "Header", "Original", true);
        const list = beginTitleSave(thread, "List", "Original", false);

        // The list's save lands first: it is now the title shown.
        expect(settleTitleSave(thread, list, "saved")).toBe("List");
        // The header's older save fails. It rolls back only itself, so the list's title stays.
        expect(settleTitleSave(thread, header, "failed")).toBe("List");
    });

    it("shows a header save that succeeded after an older list rename, and keeps it when the list rename then fails", () => {
        const thread = newThread();
        const list = beginTitleSave(thread, "List", "Original", false);
        const header = beginTitleSave(thread, "Header", "Original", true);

        expect(settleTitleSave(thread, header, "saved")).toBe("Header");
        // The older list rename fails: the newer header title is still the one the server holds.
        expect(settleTitleSave(thread, list, "failed")).toBe("Header");
    });

    it("keeps the newer save's title when an older save succeeds after it", () => {
        const thread = newThread();
        const list = beginTitleSave(thread, "List", "Original", false);
        const header = beginTitleSave(thread, "Header", "Original", true);

        expect(settleTitleSave(thread, header, "saved")).toBe("Header");
        expect(settleTitleSave(thread, list, "saved")).toBe("Header");
    });

    it("shows the list title when the newer list rename succeeds after an older header save", () => {
        const thread = newThread();
        const header = beginTitleSave(thread, "Header", "Original", true);
        const list = beginTitleSave(thread, "List", "Original", false);

        expect(settleTitleSave(thread, list, "saved")).toBe("List");
        expect(settleTitleSave(thread, header, "saved")).toBe("List");
    });

    it("goes back to the title shown before the first save when every save fails", () => {
        const thread = newThread();
        const header = beginTitleSave(thread, "Header", "Original", true);
        const list = beginTitleSave(thread, "List", "Original", false);

        expect(settleTitleSave(thread, list, "failed")).toBe("Header");
        expect(settleTitleSave(thread, header, "failed")).toBe("Original");
    });

    it("keeps the optimistic header title when an older list rename fails after it", () => {
        const thread = newThread();
        const list = beginTitleSave(thread, "List", "Original", false);
        const header = beginTitleSave(thread, "Header", "Original", true);

        // The header's save is pending but optimistic, so it stays the title while the list's is in flight.
        expect(settleTitleSave(thread, list, "failed")).toBe("Header");
        expect(settleTitleSave(thread, header, "saved")).toBe("Header");
    });

    it("restores the title shown when a header edit began, not a list rename the server has since changed", () => {
        const thread = newThread();
        const list = beginTitleSave(thread, "List", "Original", false);

        expect(settleTitleSave(thread, list, "saved")).toBe("List");

        // The server regenerates the title, so the thread now shows "Regenerated"; the header edit starts from that.
        const header = beginTitleSave(thread, "Header", "Regenerated", true);

        expect(settleTitleSave(thread, header, "failed")).toBe("Regenerated");
    });

    it("gives the header and the list one title when two renames overlap, whatever copy of the server's title each one reads", () => {
        const thread = newThread();
        const list = beginTitleSave(thread, "List", "Original", false);
        const header = beginTitleSave(thread, "Header", "Original", true);

        // The header's edit lands first and the list's last, so the server may hold either title.
        expect(settleTitleSave(thread, header, "saved")).toBe("Header");
        expect(settleTitleSave(thread, list, "saved")).toBe("Header");

        // Both still hold the server's copy from before the renames: each shows the newest save.
        expect(titleOnScreen(thread, "Original")).toBe("Header");
        expect(titleOnScreen(thread, "Original")).toBe("Header");

        // Then the server reports the newest save, and both show it.
        expect(titleOnScreen(thread, "Header")).toBe("Header");
        expect(titleOnScreen(thread, "Header")).toBe("Header");
    });

    it("shows a list rename the server has already applied, before the rename settles", () => {
        const thread = newThread();
        const list = beginTitleSave(thread, "New", "Old", false);

        // The live query reports the new title while the save is still in flight.
        expect(titleOnScreen(thread, "New")).toBe("New");

        expect(settleTitleSave(thread, list, "saved")).toBe("New");
        expect(titleOnScreen(thread, "New")).toBe("New");
    });

    it("shows a title reverted elsewhere once the server has shown the saved one", () => {
        const thread = newThread();
        const rename = beginTitleSave(thread, "B", "A", false);

        expect(settleTitleSave(thread, rename, "saved")).toBe("B");
        // The server shows the rename, so from then on it is authoritative.
        expect(titleOnScreen(thread, "B")).toBe("B");
        // Another writer renames the thread back to the old title.
        expect(titleOnScreen(thread, "A")).toBe("A");
    });

    it("announces every save that begins or settles, so the readers re-render", () => {
        const thread = newThread();
        const before = titleSaveRevision();
        const order = beginTitleSave(thread, "Next", "Current", false);

        expect(titleSaveRevision()).toBeGreaterThan(before);

        const afterBegin = titleSaveRevision();

        settleTitleSave(thread, order, "saved");
        expect(titleSaveRevision()).toBeGreaterThan(afterBegin);
    });

    it("sends a title write only after the earlier write of its thread has answered", async () => {
        const thread = newThread();
        let finish: () => void = () => {};
        const first = vi.fn(
            () =>
                new Promise<string>((resolve) => {
                    finish = () => resolve("first");
                }),
        );
        const second = vi.fn(async () => "second");

        const firstDone = queueTitleWrite(thread, first);
        const secondDone = queueTitleWrite(thread, second);

        await vi.waitFor(() => expect(first).toHaveBeenCalledTimes(1));
        expect(second).not.toHaveBeenCalled();

        finish();
        await expect(firstDone).resolves.toBe("first");
        await expect(secondDone).resolves.toBe("second");
        expect(second).toHaveBeenCalledTimes(1);
    });

    it("does not hold a later title write back when the earlier one fails", async () => {
        const thread = newThread();
        const failing = queueTitleWrite(thread, async () => {
            throw new Error("refused");
        });
        const later = queueTitleWrite(thread, async () => "later");

        await expect(failing).rejects.toThrow("refused");
        await expect(later).resolves.toBe("later");
    });

    it("shows a title the server changed on its own to both the header and the list", () => {
        const thread = newThread();
        const list = beginTitleSave(thread, "List", "Original", false);

        expect(settleTitleSave(thread, list, "saved")).toBe("List");
        expect(titleOnScreen(thread, "Regenerated")).toBe("Regenerated");
        expect(titleOnScreen(thread, "List")).toBe("List");
    });

    it("keeps a pending header title on screen while the server still holds the title it replaces", () => {
        const thread = newThread();

        beginTitleSave(thread, "Header", "Original", true);

        expect(titleOnScreen(thread, "Original")).toBe("Header");
    });

    it("reports nothing for a thread that has no save in effect", () => {
        expect(settleTitleSave(newThread(), 1, "saved")).toBeUndefined();
    });
});

describe("title saves read by two screens at different times", () => {
    it("keeps a newer pending header edit on screen when an older list rename reaches the server first", () => {
        const thread = newThread();

        beginTitleSave(thread, "B", "A", false);
        beginTitleSave(thread, "C", "B", true);

        expect(titleOnScreen(thread, "B")).toBe("C");
    });

    it("shows a title the server reverted to once it has shown the saved one, even when that is the old baseline", () => {
        const thread = newThread();
        const save = beginTitleSave(thread, "B", "A", false);

        settleTitleSave(thread, save, "saved");

        expect(titleOnScreen(thread, "B")).toBe("B");
        expect(titleOnScreen(thread, "A")).toBe("A");
    });

    it("restores a title the server changed after a successful rename when a later header edit fails", () => {
        const thread = newThread();
        const rename = beginTitleSave(thread, "A", "Original", false);

        settleTitleSave(thread, rename, "saved");
        expect(titleOnScreen(thread, "A")).toBe("A");

        // The server regenerates the title on its own.
        expect(titleOnScreen(thread, "R")).toBe("R");

        const edit = beginTitleSave(thread, "B", "R", true);

        expect(settleTitleSave(thread, edit, "failed")).toBe("R");
    });
});
