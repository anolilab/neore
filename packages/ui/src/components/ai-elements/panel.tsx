import cn from "@ui/utils/cn";
import { Panel as PanelPrimitive } from "@xyflow/react";
import type { ComponentProps } from "react";

type PanelProps = ComponentProps<typeof PanelPrimitive>;

const Panel = ({ className, ...props }: PanelProps) => (
    <PanelPrimitive className={cn("bg-card m-4 overflow-hidden rounded-md border p-1", className)} {...props} />
);

export default Panel;
