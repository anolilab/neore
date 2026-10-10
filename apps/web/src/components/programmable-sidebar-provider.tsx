import { SidebarProvider } from "@neore/ui/components/sidebar";
import type { CSSProperties, ReactNode } from "react";
import { useEffect } from "react";

import { useSidebarState } from "@/features/layout/hooks/use-ui-state";
import type { SidebarStateValue } from "@/features/layout/stores/ui-state-store";

interface ProgrammableSidebarProviderProperties<T extends string> {
    children: ReactNode;
    className?: string;
    defaultOpen?: "all" | T[];
    keyboardShortcuts?: Partial<Record<T, string>>;
    sidebarNames: ReadonlyArray<T>;
    style?: CSSProperties;
}

const ProgrammableSidebarProvider = <T extends string>({
    children,
    className,
    defaultOpen = "all",
    keyboardShortcuts,
    sidebarNames,
    style,
}: ProgrammableSidebarProviderProperties<T>): ReactNode => {
    const { setSidebarStates, sidebars } = useSidebarState();

    // Always produce a Record<T, SidebarStateValue>
    const open = ((): Record<T, SidebarStateValue> => {
        const result = {} as Record<T, SidebarStateValue>;

        sidebarNames.forEach((name) => {
            result[name] = (sidebars && sidebars[name]) || { isMobileOpen: false, isOpen: false };
        });

        return result;
    })();

    useEffect(() => {
        if (!sidebars || !setSidebarStates) {
            return;
        }

        const defaultOpenState = new Set<string>(defaultOpen === "all" ? sidebarNames : defaultOpen);
        const missingStates: Record<string, SidebarStateValue> = {};
        let hasChanges = false;

        sidebarNames.forEach((name) => {
            const existing = sidebars[name];

            if (existing) {
                return;
            }

            missingStates[name] = {
                isMobileOpen: false,
                isOpen: defaultOpenState.has(name),
            };
            hasChanges = true;
        });

        if (hasChanges) {
            setSidebarStates(missingStates);
        }
    }, [sidebarNames, defaultOpen, sidebars, setSidebarStates]);

    return (
        <SidebarProvider
            className={className}
            defaultOpen={defaultOpen}
            keyboardShortcuts={keyboardShortcuts}
            onOpenChange={setSidebarStates}
            open={open}
            sidebarNames={sidebarNames}
            style={style}
        >
            {children}
        </SidebarProvider>
    );
};

export default ProgrammableSidebarProvider;
