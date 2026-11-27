import { createFileRoute, Outlet } from "@tanstack/react-router";

import AuthMark from "@/features/auth/components/auth/auth-mark";

/** The pages outside the app shell: the canvas with one raised panel, the mark, then the page's own content. */
const RouteComponent = () => (
    <div className="bg-background flex min-h-dvh items-center justify-center p-4">
        <main className="surface-raised flex w-full max-w-[400px] flex-col gap-6 rounded-2xl p-6 sm:p-8">
            <AuthMark className="mx-auto" />
            <Outlet />
        </main>
    </div>
);

export const Route = createFileRoute("/auth")({
    component: RouteComponent,
});
