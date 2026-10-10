"use client";

import type { ReactNode } from "react";

import ProgrammableSidebarProvider from "@/components/programmable-sidebar-provider";
import { useKeyboardShortcuts } from "@/features/layout/hooks/use-ui-state";

interface DashboardSidebarProviderProperties {
    children: ReactNode;
    sidebarNames: ReadonlyArray<"left" | "right">;
    style?: React.CSSProperties;
}

const DashboardSidebarProvider = ({ children, sidebarNames, style }: DashboardSidebarProviderProperties) => {
    const { keyboardShortcuts } = useKeyboardShortcuts();

    return (
        <ProgrammableSidebarProvider
            keyboardShortcuts={{
                left: keyboardShortcuts.sidebarLeft,
                right: keyboardShortcuts.sidebarRight,
            }}
            sidebarNames={sidebarNames}
            style={style}
        >
            {children}
        </ProgrammableSidebarProvider>
    );
};

export default DashboardSidebarProvider;
