import { Trans } from "@lingui/react/macro";
import { Authenticated, AuthLoading, Unauthenticated } from "@lunora/react";
import { SidebarInset } from "@neore/ui/components/sidebar";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import GlobalCommandPalette from "@/components/command-palette";
import { ModelPickerPopup } from "@/components/model-picker";
import AutoGuestSignIn from "@/features/auth/components/auto-guest-signin";
import { KeyboardShortcutsManager } from "@/features/keyboard/components/keyboard-shortcuts-manager";
import useKeyboardShortcutHandler from "@/features/keyboard/hooks/use-keyboard-shortcut-handler";
import SidebarShortcut from "@/features/layout/components/sidebar-shortcut";

const ShortcutLayout = () => {
    const handleShortcut = useKeyboardShortcutHandler();

    return (
        <>
            <GlobalCommandPalette />
            <ModelPickerPopup />
            <KeyboardShortcutsManager onShortcut={handleShortcut}>
                <div className="flex h-dvh w-full">
                    <SidebarShortcut userDropdown />
                    <SidebarInset className="dark:bg-brand-obsidian md:ring-sidebar-border md:m-1 md:rounded-xl md:ring-1">
                        <Outlet />
                    </SidebarInset>
                </div>
            </KeyboardShortcutsManager>
        </>
    );
};

export const Route = createFileRoute("/_shortcut")({
    staleTime: 30_000,
    preloadStaleTime: 30_000,
    gcTime: 10 * 60 * 1000,
    component: () => (
        <>
            <AuthLoading>
                <div>
                    <Trans>Loading...</Trans>
                </div>
            </AuthLoading>
            <Unauthenticated>
                <AutoGuestSignIn />
            </Unauthenticated>
            <Authenticated>
                <ShortcutLayout />
            </Authenticated>
        </>
    ),
});
