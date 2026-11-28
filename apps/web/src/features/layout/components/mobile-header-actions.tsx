"use client";

import { useLingui } from "@lingui/react/macro";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/popover";
import cn from "@neore/ui/utils/cn";
import { Ellipsis } from "lucide-react";
import type { FC, ReactNode } from "react";

/**
 * With `overflow`, the popover is the header's overflow menu: those rows are listed by name, and `children` (the few actions kept
 * in the header) follow as icons. `compact` is the desktop trigger.
 *
 * Phone replacement for the header's right-hand action cluster. The actions are components with
 * their own dialogs, so they cannot become menu items; the popover stays mounted while closed so
 * a dialog opened from inside survives the popover closing.
 */
const MobileHeaderActions: FC<{ children?: ReactNode; compact?: boolean; overflow?: ReactNode }> = ({ children, compact, overflow }) => {
    const { t } = useLingui();

    return (
        <Popover>
            <PopoverTrigger
                aria-label={t`More actions`}
                className={cn(
                    "text-foreground hover:bg-accent focus-visible:ring-ring z-30 flex items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-hidden",
                    compact ? "text-muted-foreground hover:text-foreground size-7 rounded-lg" : "mr-1 size-11",
                )}
                type="button"
            >
                <Ellipsis aria-hidden="true" className="size-5" />
            </PopoverTrigger>
            {overflow ? (
                <PopoverContent align="end" aria-label={t`More actions`} className="w-60 flex-col items-stretch gap-0.5 p-1.5" keepMounted>
                    {overflow}
                    {children && (
                        <div className="border-border/50 mt-1 flex items-center gap-1 border-t pt-1.5 [&_button]:min-h-11 [&_button]:min-w-11">{children}</div>
                    )}
                </PopoverContent>
            ) : (
                <PopoverContent align="end" className="w-auto flex-row items-center gap-1 p-1.5 [&_button]:min-h-11 [&_button]:min-w-11" keepMounted>
                    {children}
                </PopoverContent>
            )}
        </Popover>
    );
};

export default MobileHeaderActions;
