import type { InternalNode, Node } from "@xyflow/react";
import { getBezierPath, Position } from "@xyflow/react";

const getHandleCoordsByPosition = (node: InternalNode<Node>, handlePosition: Position, handleId?: string) => {
    const handleType = handlePosition === Position.Left ? "target" : "source";
    const handles = node.internals.handleBounds?.[handleType];

    // Find the specific handle by ID or use the first one
    const handle = handleId ? handles?.find((h) => h.id === handleId) : handles?.find((h) => h.position === handlePosition);

    if (!handle) {
        return [0, 0] as const;
    }

    let offsetX = handle.width / 2;
    let offsetY = handle.height / 2;

    switch (handlePosition) {
        case Position.Bottom: {
            offsetY = handle.height;
            break;
        }
        case Position.Left: {
            offsetX = 0;
            break;
        }
        case Position.Right: {
            offsetX = handle.width;
            break;
        }
        case Position.Top: {
            offsetY = 0;
            break;
        }
        default: {
            break;
        }
    }

    const x = node.internals.positionAbsolute.x + handle.x + offsetX;
    const y = node.internals.positionAbsolute.y + handle.y + offsetY;

    return [x, y] as const;
};

/** The SVG path `d` of an edge from its source's right handle to its target's left handle, in flow coordinates. */
export const bezierEdgePath = (
    sourceNode: InternalNode<Node>,
    targetNode: InternalNode<Node>,
    sourceHandleId?: string | null,
    targetHandleId?: string | null,
): string => {
    const [sx, sy] = getHandleCoordsByPosition(sourceNode, Position.Right, sourceHandleId ?? undefined);
    const [tx, ty] = getHandleCoordsByPosition(targetNode, Position.Left, targetHandleId ?? undefined);

    const [edgePath] = getBezierPath({
        sourcePosition: Position.Right,
        sourceX: sx,
        sourceY: sy,
        targetPosition: Position.Left,
        targetX: tx,
        targetY: ty,
    });

    return edgePath;
};
