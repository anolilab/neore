import { createFileRoute, Outlet } from "@tanstack/react-router";

const RouteComponent = () => (
    <div className="relative container grid h-screen max-w-full items-center justify-center bg-zinc-900 lg:max-w-none lg:grid-cols-2 lg:px-0">
        <div className="relative hidden h-full flex-col p-10 text-white lg:flex dark:border-r">
            <div className="absolute inset-0 bg-zinc-900" />
            <div className="relative z-20 flex items-center text-lg font-medium">Neore AI</div>
            <div className="relative z-20 mt-auto" />
        </div>
        <div className="h-full p-2">
            <div className="flex h-full flex-1 items-center justify-center rounded-xl bg-white">
                <div className="mx-auto flex w-full flex-col justify-center space-y-6 md:w-[400px]">
                    <Outlet />
                </div>
            </div>
        </div>
    </div>
);

export const Route = createFileRoute("/auth")({
    component: RouteComponent,
});
