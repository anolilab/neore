import "@xyflow/react/dist/style.css";

import type { ReactFlowProps } from "@xyflow/react";
import { Background, ReactFlow } from "@xyflow/react";
import type { ReactNode } from "react";

type CanvasProps = ReactFlowProps & {
    children?: ReactNode;
};

const Canvas = ({ children, ...props }: CanvasProps) => (
    <ReactFlow deleteKeyCode={["Backspace", "Delete"]} fitView panOnDrag={false} panOnScroll selectionOnDrag zoomOnDoubleClick={false} {...props}>
        <Background bgColor="var(--sidebar)" />
        {children}
    </ReactFlow>
);

export default Canvas;
