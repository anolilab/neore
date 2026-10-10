"use client";

import cn from "@ui/utils/cn";
import { GripVerticalIcon } from "lucide-react";
import * as ResizablePrimitive from "react-resizable-panels";

const ResizablePanelGroup = ({ className, ...props }: ResizablePrimitive.GroupProps) => (
    <ResizablePrimitive.Group
        className={cn("cn-resizable-panel-group flex h-full w-full aria-[orientation=horizontal]:flex-col", className)}
        data-slot="resizable-panel-group"
        {...props}
    />
);

const ResizablePanel = ({ ...props }: ResizablePrimitive.PanelProps) => <ResizablePrimitive.Panel data-slot="resizable-panel" {...props} />;

const ResizableHandle = ({
    className,
    withHandle,
    ...props
}: React.ComponentProps<typeof ResizablePrimitive.Separator> & {
    withHandle?: boolean;
}) => (
    <ResizablePrimitive.Separator
        className={cn(
            "bg-border relative flex items-center justify-center",
            // when in focus
            "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-offset-1 focus-visible:outline-hidden",
            // dom pseudo element :after
            "after:absolute after:inset-y-0 after:left-1/2 after:w-1 after:-translate-x-1/2",
            // when the orientation changes
            "aria-[orientation=vertical]:h-auto aria-[orientation=vertical]:w-px",
            "aria-[orientation=horizontal]:h-px aria-[orientation=horizontal]:w-full",
            // dom pseudo element :after when the orientation changes
            "aria-[orientation=vertical]:after:left-0 aria-[orientation=vertical]:after:h-1 aria-[orientation=vertical]:after:w-full aria-[orientation=vertical]:after:translate-x-0 aria-[orientation=vertical]:after:-translate-y-1/2",
            // icon
            "[&[aria-orientation=horizontal]>div]:rotate-90",
            className,
        )}
        data-slot="resizable-handle"
        {...props}
    >
        {withHandle && (
            <div className="bg-border z-10 flex h-4 w-3 items-center justify-center rounded-xs border">
                <GripVerticalIcon className="size-2.5" />
            </div>
        )}
    </ResizablePrimitive.Separator>
);

export { ResizableHandle, ResizablePanel, ResizablePanelGroup };
