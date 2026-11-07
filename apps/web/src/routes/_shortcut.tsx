import { Trans } from "@lingui/react/macro";
import { Authenticated, AuthLoading, Unauthenticated } from "@lunora/react";
import { SidebarInset } from "@neore/ui/components/sidebar";
import { createFileRoute, Outlet } from "@tanstack/react-router";

import GlobalCommandPalette from "@/components/command-palette";
import { ModelPickerPopup } from "@/components/model-picker";
import SignInRedirect from "@/features/auth/components/sign-in-redirect";
import UnauthenticatedGate from "@/features/auth/components/unauthenticated-gate";
import { KeyboardShortcutsManager } from "@/features/keyboard/components/keyboard-shortcuts-manager";
import useKeyboardShortcutHandler from "@/features/keyboard/hooks/use-keyboard-shortcut-handler";
import SidebarShortcut from "@/features/layout/components/sidebar-shortcut";

// A live region, so a screen reader hears that the page is loading or on its way to sign-in.
const ShortcutLoading = () => (
    <div role="status">
        <Trans>Loading...</Trans>
    </div>
);

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
                <ShortcutLoading />
            </AuthLoading>
            <Unauthenticated>
                {/* A guest session when registration is open; under invite-only these pages need an account, so sign in. */}
                <UnauthenticatedGate
                    loading={<ShortcutLoading />}
                    signedOut={
                        <SignInRedirect>
                            <ShortcutLoading />
                        </SignInRedirect>
                    }
                />
            </Unauthenticated>
            <Authenticated>
                <ShortcutLayout />
            </Authenticated>
        </>
    ),
});
