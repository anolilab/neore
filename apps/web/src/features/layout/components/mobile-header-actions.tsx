"use client";

import { useLingui } from "@lingui/react/macro";
import { Popover, PopoverContent, PopoverTrigger } from "@neore/ui/components/popover";
import { Ellipsis } from "lucide-react";
import type { FC, ReactNode } from "react";

/**
 * Phone replacement for the header's right-hand action cluster. The actions are components with
 * their own dialogs, so they cannot become menu items; the popover stays mounted while closed so
 * a dialog opened from inside survives the popover closing.
 */
const MobileHeaderActions: FC<{ children: ReactNode }> = ({ children }) => {
    const { t } = useLingui();

    return (
        <Popover>
            <PopoverTrigger
                aria-label={t`More actions`}
                className="text-foreground hover:bg-accent focus-visible:ring-ring z-30 mr-1 flex size-11 items-center justify-center rounded-md focus-visible:ring-2 focus-visible:outline-hidden"
                type="button"
            >
                <Ellipsis aria-hidden="true" className="size-5" />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto flex-row items-center gap-1 p-1.5 [&_button]:min-h-11 [&_button]:min-w-11" keepMounted>
                {children}
            </PopoverContent>
        </Popover>
    );
};

export default MobileHeaderActions;
