import { Skeleton } from "@neore/ui/components/skeleton";
import type { FC } from "react";

import SiteHeader from "@/features/layout/components/site-header";

const ChatLoadingSkeleton: FC = () => (
    <div className="flex h-dvh w-full">
        {/* Left sidebar with navigation icons */}
        <div className="flex shrink-0">
            {/* Navigation icons column */}
            <div className="bg-sidebar h-screen w-12 py-1 pl-1">
                <div className="dark bg-sidebar-foreground flex h-full flex-col items-center justify-center gap-2 rounded-lg shadow-xl">
                    {Array.from({ length: 4 }, (_, index) => (
                        <Skeleton className="size-8 rounded-lg" key={index} />
                    ))}
                </div>
            </div>
            {/* Sidebar content area */}
            <div className="bg-sidebar relative z-10 flex w-69 flex-col rounded-l-xl">
                {/* Sidebar header */}
                <div className="flex shrink-0 items-center gap-2 px-4 py-2">
                    <Skeleton className="size-8 rounded-lg" />
                    <div className="flex-1 space-y-1">
                        <Skeleton className="h-4 w-24" />
                        <Skeleton className="h-3 w-32" />
                    </div>
                </div>
                {/* Sidebar content */}
                <div className="flex-1 overflow-y-auto">
                    <div className="text-foreground flex flex-col items-stretch gap-1.5 pl-2 dark:text-white">
                        {/* Action buttons skeleton - matches ThreadList structure */}
                        <div className="flex w-full items-center gap-2">
                            <Skeleton className="h-9 w-9 rounded-md" />
                            <Skeleton className="h-9 w-9 rounded-md" />
                            <Skeleton className="h-9 w-9 rounded-md" />
                        </div>
                        {/* Thread list items skeleton */}
                        {Array.from({ length: 4 }, (_, index) => (
                            <div className="space-y-2 rounded-lg p-2" key={index}>
                                <Skeleton className="h-5 w-full" />
                                <Skeleton className="h-4 w-3/4" />
                            </div>
                        ))}
                    </div>
                </div>
                {/* Sidebar footer */}
                <div className="flex shrink-0 p-2">
                    <div className="w-full space-y-2">
                        <Skeleton className="h-16 w-full rounded-lg" />
                        <Skeleton className="h-12 w-full rounded-lg" />
                    </div>
                </div>
            </div>
        </div>
        {/* Main content area - matches SidebarInset exactly */}
        <main
            className="bg-sidebar-foreground md:peer-data-[variant=inset]:ring-sidebar-border relative flex w-full flex-1 flex-col md:peer-data-[variant=inset]:m-1 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:ring-1 md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-1"
            id="main-content"
        >
            {/* Header using actual SiteHeader component */}
            <SiteHeader
                menu={
                    <>
                        <Skeleton className="h-6 w-6 rounded-md" />
                    </>
                }
            >
                <div className="flex items-center gap-2">
                    <Skeleton className="h-7 w-48" />
                </div>
            </SiteHeader>
            {/* Thread area skeleton - matches Thread structure exactly */}
            <div className="h-full pb-2">
                <div className="thread-viewport h-full">
                    <div className="flex h-full flex-col items-center overflow-x-auto overflow-y-scroll scroll-smooth bg-inherit px-4 pt-8">
                        {/* Message list skeleton - matches actual message layout */}
                        <div className="message-list flex w-full max-w-(--thread-max-width) flex-col">
                            {/* User message skeleton */}
                            <div className="message-item pb-6" data-message-role="user">
                                <div className="relative grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 [&:where(>*)]:col-start-2">
                                    <div className="col-start-2 row-start-2 rounded-3xl px-5 py-2.5 wrap-break-word">
                                        <Skeleton className="h-5 w-64" />
                                    </div>
                                </div>
                            </div>

                            {/* Assistant message skeleton */}
                            <div className="message-item pb-6" data-message-role="assistant">
                                <div className="relative grid w-full max-w-(--thread-max-width) grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] gap-y-2">
                                    <div className="col-span-2 col-start-2 row-start-1 space-y-2 leading-7 wrap-break-word">
                                        <Skeleton className="h-4 w-full" />
                                        <Skeleton className="h-4 w-[95%]" />
                                        <Skeleton className="h-4 w-[90%]" />
                                    </div>
                                </div>
                            </div>

                            {/* User message skeleton */}
                            <div className="message-item pb-6" data-message-role="user">
                                <div className="relative grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 [&:where(>*)]:col-start-2">
                                    <div className="col-start-2 row-start-2 rounded-3xl px-5 py-2.5 wrap-break-word">
                                        <Skeleton className="h-5 w-48" />
                                    </div>
                                </div>
                            </div>

                            {/* Assistant message skeleton (streaming) */}
                            <div className="message-item pb-0" data-message-role="assistant">
                                <div className="relative grid w-full max-w-(--thread-max-width) grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] gap-y-2">
                                    <div className="col-span-2 col-start-2 row-start-1 leading-7 wrap-break-word">
                                        <Skeleton className="h-4 w-32" />
                                    </div>
                                </div>
                            </div>
                        </div>
                        {/* Composer area skeleton - matches ThreadPrimitive.ViewportFooter */}
                        <div className="sticky bottom-0 flex w-full max-w-(--thread-max-width) flex-col items-center justify-end rounded-t-lg bg-inherit">
                            <Skeleton className="h-32 w-full rounded-lg" />
                        </div>
                    </div>
                </div>
            </div>
        </main>
    </div>
);

export default ChatLoadingSkeleton;
