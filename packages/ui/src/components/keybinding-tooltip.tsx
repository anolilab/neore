import * as React from "react";

import cn from "../utils/cn";
import { TooltipContent, TooltipProvider } from "./tooltip";

interface KeybindingTooltipProperties {
    align?: "start" | "center" | "end";
    children: React.ReactNode;
    className?: string;
    hidden?: boolean;
    side?: "top" | "right" | "bottom" | "left";
    text: React.ReactNode;
}

const KeybindingTooltip: React.FC<KeybindingTooltipProperties> = ({ align = "center", children, className, hidden = false, side = "top", text }) => {
    if (hidden) {
        return <>{children}</>;
    }

    return (
        <TooltipProvider delayDuration={0}>
            <div className={cn("inline-flex", className)}>
                <TooltipContent align={align} side={side}>
                    {text}
                </TooltipContent>
                {children}
            </div>
        </TooltipProvider>
    );
};

export default KeybindingTooltip;
