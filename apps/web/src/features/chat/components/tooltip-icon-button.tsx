"use client";

import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import cn from "@neore/ui/utils/cn";
import type { ComponentPropsWithRef } from "react";

export type TooltipIconButtonProps = ComponentPropsWithRef<typeof Button> & {
    side?: "top" | "bottom" | "left" | "right";
    tooltip: string;
};

const TooltipIconButton = ({
    children,
    className,
    ref,
    side = "bottom",
    tooltip,
    ...rest
}: TooltipIconButtonProps & { ref?: React.RefObject<HTMLButtonElement | null> }) => (
    <Tooltip>
        <TooltipTrigger
            render={
                <Button size="icon" variant="ghost" {...rest} className={cn("size-6 p-1", className)} ref={ref}>
                    {children}
                    <span className="sr-only">{tooltip}</span>
                </Button>
            }
        />
        <TooltipContent side={side}>{tooltip}</TooltipContent>
    </Tooltip>
);

TooltipIconButton.displayName = "TooltipIconButton";

export default TooltipIconButton;
