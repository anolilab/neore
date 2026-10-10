import type { EdgeProps, InternalNode, Node } from "@xyflow/react";
import { BaseEdge, getBezierPath, Position, useInternalNode } from "@xyflow/react";
import { memo } from "react";

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

const AnimatedEdgeComponent = ({ id, markerEnd, selected, source, sourceHandleId, style, target, targetHandleId }: EdgeProps) => {
    const sourceNode = useInternalNode(source);
    const targetNode = useInternalNode(target);

    if (!sourceNode || !targetNode) {
        return null;
    }

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

    return (
        <>
            <BaseEdge
                id={id}
                markerEnd={markerEnd}
                path={edgePath}
                style={{
                    ...style,
                    stroke: selected ? "var(--primary)" : "var(--muted-foreground)",
                    strokeWidth: selected ? 2 : 1.5,
                }}
            />
            {/* Animated dot */}
            <circle fill="var(--primary)" opacity={0.8} r={selected ? 4 : 3}>
                <animateMotion dur="2s" path={edgePath} repeatCount="indefinite" />
            </circle>
        </>
    );
};

const AnimatedEdge = memo(AnimatedEdgeComponent);

export default AnimatedEdge;
