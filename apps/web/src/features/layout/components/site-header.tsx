import { Separator } from "@neore/ui/components/separator";
import cn from "@neore/ui/utils/cn";
import type { FC, PropsWithChildren, ReactNode } from "react";
import { useMediaMatch } from "rooks";

import MobileHeaderActions from "@/features/layout/components/mobile-header-actions";
import WorkspaceSwitch from "@/features/layout/components/workspace-switch";

const PHONE_QUERY = "(max-width: 639px)";

const SiteHeader: FC<
    PropsWithChildren<{
        anonymousUserBanner?: ReactNode;
        menu?: ReactNode;
        notch?: boolean;
        /** Actions listed by name in one overflow menu, after the few kept in `menu`. */
        overflow?: ReactNode;
        themeToggle?: ReactNode;
        title?: string;
        trigger?: ReactNode;
        workspaceSwitch?: boolean;
    }>
> = ({ anonymousUserBanner, children, menu, notch, overflow, themeToggle, title, trigger, workspaceSwitch }) => {
    // Phones get the overflow button; everything else the cluster. Mounted once, never both.
    const isPhone = useMediaMatch(PHONE_QUERY);

    return (
        <header
            className="text-foreground relative flex h-(--header-height) w-full shrink-0 items-center gap-2 transition-[width,height] ease-linear"
            data-chrome=""
        >
            <div className={cn("relative z-20 flex h-full w-full items-center gap-1", !trigger && !workspaceSwitch && "ps-4")}>
                {trigger}
                {trigger && <Separator className="mx-2 mt-2 data-[orientation=vertical]:h-6" orientation="vertical" />}
                {workspaceSwitch && <WorkspaceSwitch />}
                {title && <h1 className="text-sm font-medium">{title}</h1>}
                {children}
                <div className="grow" />
                {anonymousUserBanner}
                <div className="grow" />
                {isPhone && (themeToggle || menu || overflow) && (
                    <MobileHeaderActions overflow={overflow}>
                        {themeToggle}
                        {menu}
                    </MobileHeaderActions>
                )}
                {!isPhone && notch !== false && (
                    <div className="[&_[data-slot=button]:hover]:bg-surface-row-hover flex shrink-0 items-center gap-0.5 pr-3 [&_[data-slot=button]]:size-7 [&_[data-slot=button]]:rounded-lg">
                        {overflow && <MobileHeaderActions compact overflow={overflow} />}
                        {themeToggle}
                        {menu}
                    </div>
                )}
            </div>
        </header>
    );
};

export default SiteHeader;
