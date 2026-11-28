import { SidebarInset } from "@neore/ui/components/sidebar";
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import SidebarShortcut from "@/features/layout/components/sidebar-shortcut";

const WorkflowLayout = () => (
    <div className="flex h-dvh w-full">
        <SidebarShortcut userDropdown />
        <SidebarInset className="bg-surface-main surface-edge overflow-hidden md:m-2 md:rounded-2xl">
            <Outlet />
        </SidebarInset>
    </div>
);

export const Route = createFileRoute("/(chat)/workflow")({
    component: WorkflowLayout,
    ssr: false,
    staleTime: 30_000,
    preloadStaleTime: 30_000,
    gcTime: 10 * 60 * 1000,
    beforeLoad: ({ context }) => {
        const flags = (context as { posthog?: { flags: Record<string, boolean | string> } }).posthog?.flags ?? {};

        if (!flags["workflow"]) {
            throw redirect({ to: "/" });
        }
    },
});
