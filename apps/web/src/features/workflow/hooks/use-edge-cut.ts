import { useReactFlow } from "@xyflow/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useRef } from "react";

import { bezierEdgePath } from "../components/edges/edge-geometry";
import { flushPendingHistory } from "../stores/history-store";
import { useWorkflowStore } from "../stores/workflow-store";
import type { Point } from "../utils/edge-cut";
import { edgesCrossedBy, sampleBezierPath } from "../utils/edge-cut";

/**
 * Alt/Ctrl + drag on empty canvas draws a line that cuts the edges it crosses. Returns the cut line's
 * ref (the line is moved imperatively, so the canvas does not re-render per mouse move) and the
 * capture-phase pointerdown handler to attach to the canvas wrapper. Must run inside a ReactFlowProvider.
 */
export const useEdgeCut = () => {
    const cutLineRef = useRef<SVGLineElement>(null);
    const { getInternalNode, screenToFlowPosition } = useReactFlow();

    // Removes, in one edit, every edge the cut segment (flow coordinates) crosses. Geometry is
    // read from the same path the edge renders, so what the user sees is what gets cut.
    const cutEdgesAlong = (from: Point, to: Point) => {
        const { edges: currentEdges, setEdges } = useWorkflowStore.getState();
        const geometry = currentEdges.flatMap((edge) => {
            const source = getInternalNode(edge.source);
            const target = getInternalNode(edge.target);

            if (!source || !target) return [];

            return [{ id: edge.id, points: sampleBezierPath(bezierEdgePath(source, target, edge.sourceHandle, edge.targetHandle)) }];
        });
        const crossed = new Set(edgesCrossedBy([from, to], geometry));

        if (crossed.size === 0) return;

        // Commit any pending edit first so the cut is its own undo step.
        flushPendingHistory();
        setEdges(currentEdges.filter((edge) => !crossed.has(edge.id)));
    };

    const onPointerDownCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
        const target = event.target as HTMLElement;
        const cutLine = cutLineRef.current;

        if (event.button !== 0 || !event.isPrimary || !(event.altKey || event.ctrlKey) || !cutLine) return;

        if (!target.closest(".react-flow__pane") || target.closest(".react-flow__node, .react-flow__edge")) return;

        // The press is captured before React Flow's pane sees it (its selection starts on pointerdown), and
        // cancelling pointerdown also stops the compatibility mouse events that pan listens for.
        event.preventDefault();
        event.stopPropagation();

        const bounds = event.currentTarget.getBoundingClientRect();
        const origin = { x: event.clientX, y: event.clientY };
        // Only the pointer that started the cut may move or finish it; another pointer's events are ignored.
        const { pointerId } = event;
        const controller = new AbortController();
        const { signal } = controller;
        const end = () => {
            controller.abort();
            cutLine.setAttribute("visibility", "hidden");
        };

        cutLine.setAttribute("x1", String(origin.x - bounds.left));
        cutLine.setAttribute("y1", String(origin.y - bounds.top));
        cutLine.setAttribute("x2", String(origin.x - bounds.left));
        cutLine.setAttribute("y2", String(origin.y - bounds.top));
        cutLine.setAttribute("visibility", "hidden");

        globalThis.addEventListener(
            "pointermove",
            (move: PointerEvent) => {
                if (move.pointerId !== pointerId) return;

                cutLine.setAttribute("x2", String(move.clientX - bounds.left));
                cutLine.setAttribute("y2", String(move.clientY - bounds.top));
                cutLine.setAttribute("visibility", "visible");
            },
            { signal },
        );
        globalThis.addEventListener(
            "pointerup",
            (up: PointerEvent) => {
                if (up.pointerId !== pointerId) return;

                end();

                if (Math.hypot(up.clientX - origin.x, up.clientY - origin.y) < 2) return;

                cutEdgesAlong(screenToFlowPosition(origin), screenToFlowPosition({ x: up.clientX, y: up.clientY }));
            },
            { signal },
        );
        // A cancelled pointer cuts nothing; it only clears the line.
        globalThis.addEventListener(
            "pointercancel",
            (cancel: PointerEvent) => {
                if (cancel.pointerId === pointerId) end();
            },
            { signal },
        );
        // macOS opens the context menu on Ctrl+press, before the drag ends.
        globalThis.addEventListener("contextmenu", (menu: Event) => menu.preventDefault(), { signal });
    };

    return { cutLineRef, onPointerDownCapture };
};
