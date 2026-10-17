import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { WorkflowContent, WorkflowNode } from "../types";
import { HISTORY_DEBOUNCE_MS, MAX_HISTORY_ENTRIES, redoWorkflow, startHistoryRecording, undoWorkflow, useHistoryStore, withoutHistory } from "./history-store";
import { useWorkflowStore } from "./workflow-store";

vi.mock("@lingui/core/macro", () => {
    return {
        msg: (strings: TemplateStringsArray) => {
            return { id: strings.join("") };
        },
    };
});

const node = (id: string, x = 0, data: Record<string, unknown> = {}): WorkflowNode =>
    ({ data: { label: id, ...data }, id, position: { x, y: 0 }, type: "text" }) as unknown as WorkflowNode;

const content = (...nodes: WorkflowNode[]): WorkflowContent => {
    return { edges: [], nodes };
};

const moveNode = (x: number): void => {
    useWorkflowStore.getState().onNodesChange([{ dragging: true, id: "a", position: { x, y: 0 }, type: "position" }]);
};

const positionOf = (id: string): number | undefined => useWorkflowStore.getState().nodes.find((n) => n.id === id)?.position.x;

const recording: { stop: () => void } = { stop: () => {} };

beforeEach(() => {
    vi.useFakeTimers();
    useWorkflowStore.getState().reset();
    useHistoryStore.getState().clearHistory();
    recording.stop = startHistoryRecording();
    useWorkflowStore.getState().setProjectId("p1");
    withoutHistory(() => useWorkflowStore.getState().loadContent(content(node("a"))));
});

afterEach(() => {
    recording.stop();
    vi.useRealTimers();
});

describe("workflow history recording", () => {
    it("records a drag burst as one step that undo reverts", () => {
        for (let x = 1; x <= 20; x += 1) {
            moveNode(x * 10);
            vi.advanceTimersByTime(50);
        }

        useWorkflowStore.getState().onNodesChange([{ dragging: false, id: "a", type: "position" }]);
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(useHistoryStore.getState().entries).toHaveLength(2);

        undoWorkflow();

        expect(positionOf("a")).toBe(0);
        expect(useHistoryStore.getState().canUndo()).toBe(false);
    });

    it("does not split a drag held still past the quiet period", () => {
        moveNode(10);
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS * 3);
        moveNode(40);
        useWorkflowStore.getState().onNodesChange([{ dragging: false, id: "a", type: "position" }]);
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(useHistoryStore.getState().entries).toHaveLength(2);
    });

    it("ignores select-only changes", () => {
        useWorkflowStore.getState().onNodesChange([{ id: "a", selected: true, type: "select" }]);
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(useHistoryStore.getState().entries).toHaveLength(0);
    });

    it("records no step for a guarded remote apply, but does for the same write unguarded", () => {
        withoutHistory(() => useWorkflowStore.getState().loadContent(content(node("a"), node("b"))));
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(useHistoryStore.getState().entries).toHaveLength(0);

        useWorkflowStore.getState().loadContent(content(node("a"), node("b"), node("c")));
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(useHistoryStore.getState().entries).toHaveLength(2);
    });

    it("keeps resolved image URLs out of history", () => {
        withoutHistory(() => useWorkflowStore.getState().loadContent(content(node("a", 0, { imageFileId: "f1", imageUrl: "https://signed.example/x" }))));
        useWorkflowStore.getState().updateNode("a", { label: "renamed" });
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(JSON.stringify(useHistoryStore.getState().entries)).not.toContain("signed.example");
    });

    it("round-trips undo and redo, marks the restore dirty and records nothing for it", () => {
        useWorkflowStore.getState().updateNode("a", { label: "one" });
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
        useWorkflowStore.getState().setDirty(false);

        undoWorkflow();
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(useWorkflowStore.getState().nodes[0]?.data.label).toBe("a");
        expect(useWorkflowStore.getState().isDirty).toBe(true);
        expect(useHistoryStore.getState().isNavigating).toBe(false);
        expect(useHistoryStore.getState().entries).toHaveLength(2);

        redoWorkflow();

        expect(useWorkflowStore.getState().nodes[0]?.data.label).toBe("one");
        expect(useHistoryStore.getState().isNavigating).toBe(false);
    });

    it("records no step for a pan and leaves the viewport alone on undo", () => {
        useWorkflowStore.getState().setViewport({ x: 120, y: -40, zoom: 1.5 });
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);

        expect(useHistoryStore.getState().entries).toHaveLength(0);

        useWorkflowStore.getState().updateNode("a", { label: "one" });
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
        useWorkflowStore.getState().setViewport({ x: 300, y: 80, zoom: 0.5 });
        undoWorkflow();

        expect(useWorkflowStore.getState().nodes[0]?.data.label).toBe("a");
        expect(useWorkflowStore.getState().viewport).toStrictEqual({ x: 300, y: 80, zoom: 0.5 });
    });

    it("commits a pending edit before undoing it", () => {
        useWorkflowStore.getState().updateNode("a", { label: "typed" });
        undoWorkflow();

        expect(useWorkflowStore.getState().nodes[0]?.data.label).toBe("a");
    });

    it("caps history at the maximum depth", () => {
        for (let x = 1; x <= MAX_HISTORY_ENTRIES + 10; x += 1) {
            useWorkflowStore.getState().updateNode("a", { label: `v${x}` });
            vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
        }

        expect(useHistoryStore.getState().entries).toHaveLength(MAX_HISTORY_ENTRIES);
    });

    it("resets history when the workflow changes", () => {
        useWorkflowStore.getState().updateNode("a", { label: "one" });
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
        useWorkflowStore.getState().setProjectId("p2");

        expect(useHistoryStore.getState().entries).toHaveLength(0);
    });

    it("starts from a clean history when recording restarts", () => {
        useWorkflowStore.getState().updateNode("a", { label: "one" });
        vi.advanceTimersByTime(HISTORY_DEBOUNCE_MS);
        recording.stop();
        recording.stop = startHistoryRecording();

        expect(useHistoryStore.getState().entries).toHaveLength(0);
    });
});
