import { describe, expect, it, vi } from "vitest";

import type { DragEndMutations } from "./apply-drag-end";
import applyDragEnd from "./apply-drag-end";
import type { ThreadGroup } from "./types";

const group = (title: string, threadIds: string[], projectId?: string): ThreadGroup =>
    ({
        projectId,
        threads: threadIds.map((threadId: string) => {
            return { threadId };
        }),
        title,
    }) as unknown as ThreadGroup;

const mutations = (): DragEndMutations & { [K in keyof DragEndMutations]: ReturnType<typeof vi.fn> } => {
    return {
        moveThreadToProject: vi.fn(async () => undefined),
        updateProjectOrder: vi.fn(async () => undefined),
        updateThreadOrder: vi.fn(async () => undefined),
    };
};

const groups: ThreadGroup[] = [group("Alpha", ["a1", "a2"], "pA"), group("Beta", ["b1"], "pB"), group("Today", ["t1", "t2", "t3"])];

describe(applyDragEnd, () => {
    it("reorders project groups when one project group is dropped on another", async () => {
        const saved = mutations();

        await applyDragEnd({ id: "project-group-pB" }, { id: "project-group-pA" }, groups, saved);

        expect(saved.updateProjectOrder).toHaveBeenCalledWith({
            projectOrders: [
                { order: 0, projectId: "pB" },
                { order: 1, projectId: "pA" },
            ],
        });
        expect(saved.moveThreadToProject).not.toHaveBeenCalled();
    });

    it("saves nothing when a project group is dropped on itself or nowhere known", async () => {
        const saved = mutations();

        await applyDragEnd({ id: "project-group-pA" }, { id: "project-pA" }, groups, saved);
        await applyDragEnd({ id: "project-group-pA" }, { id: "t1" }, groups, saved);

        expect(saved.updateProjectOrder).not.toHaveBeenCalled();
        expect(saved.updateThreadOrder).not.toHaveBeenCalled();
    });

    it("moves a thread into the project whose container it is dropped on", async () => {
        const saved = mutations();

        await applyDragEnd({ id: "t1" }, { id: "project-pB" }, groups, saved);
        await applyDragEnd({ id: "a1" }, { data: { current: { projectId: "pB", type: "project-container" } }, id: 7 }, groups, saved);

        expect(saved.moveThreadToProject).toHaveBeenNthCalledWith(1, { projectId: "pB", threadId: "t1" });
        expect(saved.moveThreadToProject).toHaveBeenNthCalledWith(2, { projectId: "pB", threadId: "a1" });
    });

    it("does not move a thread onto the container of the project it is already in", async () => {
        const saved = mutations();

        await applyDragEnd({ id: "a1" }, { id: "project-pA" }, groups, saved);

        expect(saved.moveThreadToProject).not.toHaveBeenCalled();
    });

    it("moves a thread between projects, out of one, and into one when dropped on a thread of another group", async () => {
        const saved = mutations();

        await applyDragEnd({ id: "a1" }, { id: "b1" }, groups, saved);
        await applyDragEnd({ id: "a1" }, { id: "t2" }, groups, saved);
        await applyDragEnd({ id: "t1" }, { id: "b1" }, groups, saved);

        expect(saved.moveThreadToProject.mock.calls).toStrictEqual([
            [{ projectId: "pB", threadId: "a1" }],
            [{ projectId: undefined, threadId: "a1" }],
            [{ projectId: "pB", threadId: "t1" }],
        ]);
        expect(saved.updateThreadOrder).not.toHaveBeenCalled();
    });

    it("reorders threads within one group", async () => {
        const saved = mutations();

        await applyDragEnd({ id: "t3" }, { id: "t1" }, groups, saved);

        expect(saved.updateThreadOrder).toHaveBeenCalledWith({
            threadOrders: [
                { order: 0, threadId: "t3" },
                { order: 1, threadId: "t1" },
                { order: 2, threadId: "t2" },
            ],
        });
    });

    it("saves nothing for a thread dropped on an unknown target", async () => {
        const saved = mutations();

        await applyDragEnd({ id: "t1" }, { id: "missing" }, groups, saved);

        expect(saved.moveThreadToProject).not.toHaveBeenCalled();
        expect(saved.updateThreadOrder).not.toHaveBeenCalled();
    });

    it("rejects when the save fails, so the list can report it", async () => {
        const saved = mutations();

        saved.updateThreadOrder.mockRejectedValueOnce(new Error("offline"));

        await expect(applyDragEnd({ id: "t3" }, { id: "t1" }, groups, saved)).rejects.toThrow("offline");
    });
});
