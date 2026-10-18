import type { EdgeProps } from "@xyflow/react";
import { BaseEdge, useInternalNode } from "@xyflow/react";
import { memo } from "react";

import { bezierEdgePath } from "./edge-geometry";

const AnimatedEdgeComponent = ({ id, markerEnd, selected, source, sourceHandleId, style, target, targetHandleId }: EdgeProps) => {
    const sourceNode = useInternalNode(source);
    const targetNode = useInternalNode(target);

    if (!sourceNode || !targetNode) {
        return null;
    }

    const edgePath = bezierEdgePath(sourceNode, targetNode, sourceHandleId, targetHandleId);

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
