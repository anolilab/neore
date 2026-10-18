import { renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { useEdgeCut } from "./use-edge-cut";

const { screenToFlowPosition } = vi.hoisted(() => {
    return {
        screenToFlowPosition: vi.fn((point: { x: number; y: number }) => point),
    };
});

// The stores pull in lingui macros, which only run under the app's compile step; the cut path is never reached with edges.
vi.mock("../stores/workflow-store", () => {
    return {
        useWorkflowStore: {
            getState: () => {
                return { edges: [], setEdges: () => {} };
            },
        },
    };
});
vi.mock("../stores/history-store", () => {
    return { flushPendingHistory: () => {} };
});

vi.mock("@xyflow/react", async (importOriginal) => {
    return {
        ...(await importOriginal<typeof import("@xyflow/react")>()),
        useReactFlow: () => {
            return { getInternalNode: () => undefined, screenToFlowPosition };
        },
    };
});

const pointerDown = (init: { clientX: number; clientY: number; pointerId: number }) =>
    ({
        altKey: true,
        button: 0,
        clientX: init.clientX,
        clientY: init.clientY,
        ctrlKey: false,
        currentTarget: {
            getBoundingClientRect: () => {
                return { left: 0, top: 0 };
            },
        },
        isPrimary: true,
        pointerId: init.pointerId,
        preventDefault: () => {},
        stopPropagation: () => {},
        target: { closest: (selector: string) => (selector === ".react-flow__pane" ? {} : null) },
    }) as unknown as ReactPointerEvent<HTMLDivElement>;

const dispatchPointer = (type: "pointermove" | "pointerup", init: { clientX: number; clientY: number; pointerId: number }) => {
    globalThis.dispatchEvent(Object.assign(new Event(type), init));
};

describe(useEdgeCut, () => {
    it("ignores a second pointer and lets only the initiating pointer move or finish the cut", () => {
        screenToFlowPosition.mockClear();

        const { result } = renderHook(() => useEdgeCut());
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");

        result.current.cutLineRef.current = line;
        result.current.onPointerDownCapture(pointerDown({ clientX: 10, clientY: 10, pointerId: 1 }));

        // A second pointer moving does not draw the line, and releasing it does not end the cut.
        dispatchPointer("pointermove", { clientX: 500, clientY: 500, pointerId: 2 });

        expect(line.getAttribute("visibility")).toBe("hidden");

        dispatchPointer("pointerup", { clientX: 300, clientY: 300, pointerId: 2 });

        expect(screenToFlowPosition).not.toHaveBeenCalled();

        // The initiating pointer still draws, and its release is the one that cuts (at its own coordinates).
        dispatchPointer("pointermove", { clientX: 40, clientY: 40, pointerId: 1 });

        expect(line.getAttribute("x2")).toBe("40");
        expect(line.getAttribute("visibility")).toBe("visible");

        dispatchPointer("pointerup", { clientX: 40, clientY: 40, pointerId: 1 });

        expect(screenToFlowPosition).toHaveBeenCalledWith({ x: 10, y: 10 });
        expect(screenToFlowPosition).toHaveBeenCalledWith({ x: 40, y: 40 });
    });
});
