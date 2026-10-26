import { Trans } from "@lingui/react/macro";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarInset, SidebarProvider } from "@neore/ui/components/sidebar";
import { Skeleton } from "@neore/ui/components/skeleton";
import type { FC } from "react";
import { useEffect, useState } from "react";

import SiteHeader from "@/features/layout/components/site-header";

import { chatDefaultOpen, chatSidebarNames, chatSidebarStyle } from "../shell-layout";

/** Auth can take this long before the page is worth explaining. */
const STALLED_AFTER_MS = 8000;

/**
 * Shown while auth is loading. It mounts the same sidebar primitives as the signed-in shell, with the
 * same geometry, so the page does not move when it fills in. The fade starts after 200ms, so a fast
 * auth never shows it at all.
 */
const ChatLoadingSkeleton: FC = () => {
    const [isStalled, setIsStalled] = useState(false);

    useEffect(() => {
        const timer = setTimeout(setIsStalled, STALLED_AFTER_MS, true);

        return () => {
            clearTimeout(timer);
        };
    }, []);

    return (
        <SidebarProvider defaultOpen={chatDefaultOpen} sidebarNames={chatSidebarNames} style={chatSidebarStyle}>
            <div className="animate-in fade-in flex h-dvh w-full duration-150 [--tw-animation-delay:200ms] [--tw-animation-fill-mode:both] motion-reduce:animate-none">
                {/* Mirrors SidebarShortcut's geometry; the real one reads session and settings data, so it is not mounted here. */}
                <div className="z-20 hidden h-screen w-16 shrink-0 py-1 pl-1 md:block">
                    <div className="bg-sidebar ring-sidebar-border flex h-full flex-col items-center rounded-lg ring-1">
                        <Skeleton className="mt-3 mb-4 size-7 rounded-md" />
                        <div className="mt-4 flex flex-col gap-1">
                            {Array.from({ length: 4 }, (_, index) => (
                                <Skeleton className="size-9 rounded-lg" key={index} />
                            ))}
                        </div>
                    </div>
                </div>
                <Sidebar className="left-16 [&>div]:flex-row" collapsible="offcanvas" name="left" variant="inset">
                    <div className="relative z-10 flex w-(--sidebar-width) flex-col rounded-l-xl">
                        <SidebarHeader>
                            <div className="text-brand-black flex flex-col items-stretch gap-1.5 pl-2">
                                <Skeleton className="h-9 w-full rounded-lg" />
                                <div className="flex items-center gap-2">
                                    <Skeleton className="h-9 flex-1 rounded-lg" />
                                    <Skeleton className="size-9 rounded-md" />
                                </div>
                            </div>
                        </SidebarHeader>
                        <SidebarContent>
                            <div className="text-brand-black flex flex-col items-stretch gap-1.5 pl-2">
                                {Array.from({ length: 6 }, (_, index) => (
                                    <div className="space-y-2 rounded-lg p-2" key={index}>
                                        <Skeleton className="h-4 w-full" />
                                        <Skeleton className="h-3 w-3/4" />
                                    </div>
                                ))}
                            </div>
                        </SidebarContent>
                        <SidebarFooter>
                            <Skeleton className="h-12 w-full rounded-lg" />
                        </SidebarFooter>
                    </div>
                </Sidebar>
                <SidebarInset className="dark:bg-brand-obsidian md:peer-data-[variant=inset]:m-1">
                    <SiteHeader>
                        <Skeleton className="h-7 w-48" />
                    </SiteHeader>
                    <div className="h-full pb-2">
                        <div className="thread-viewport h-full">
                            <div className="flex h-full flex-col items-center overflow-x-auto overflow-y-scroll bg-inherit px-4 pt-8">
                                {/* Mounted from the start, so the live region exists before its text changes; visually hidden until the stall. */}
                                <p className={isStalled ? "text-muted-foreground pb-4 text-sm" : "sr-only"} role="status">
                                    {isStalled && <Trans>Still connecting to the server...</Trans>}
                                </p>
                                <div aria-hidden="true" className="message-list flex w-full max-w-(--thread-max-width) flex-col">
                                    <div className="message-item pb-6" data-message-role="user">
                                        <div className="relative grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 [&:where(>*)]:col-start-2">
                                            <div className="col-start-2 row-start-2 rounded-3xl px-5 py-2.5 wrap-break-word">
                                                <Skeleton className="h-5 w-64" />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="message-item pb-6" data-message-role="assistant">
                                        <div className="relative grid w-full max-w-(--thread-max-width) grid-cols-[auto_auto_1fr] grid-rows-[auto_1fr] gap-y-2">
                                            <div className="col-span-2 col-start-2 row-start-1 space-y-2 leading-7 wrap-break-word">
                                                <Skeleton className="h-4 w-full" />
                                                <Skeleton className="h-4 w-[95%]" />
                                                <Skeleton className="h-4 w-[90%]" />
                                            </div>
                                        </div>
                                    </div>
                                    <div className="message-item pb-6" data-message-role="user">
                                        <div className="relative grid w-full max-w-(--thread-max-width) auto-rows-auto grid-cols-[minmax(72px,1fr)_auto] gap-y-2 [&:where(>*)]:col-start-2">
                                            <div className="col-start-2 row-start-2 rounded-3xl px-5 py-2.5 wrap-break-word">
                                                <Skeleton className="h-5 w-48" />
                                            </div>
                                        </div>
                                    </div>
                                </div>
                                <div className="sticky bottom-0 flex w-full max-w-(--thread-max-width) flex-col items-center justify-end rounded-t-lg bg-inherit">
                                    <Skeleton className="h-32 w-full rounded-lg" />
                                </div>
                            </div>
                        </div>
                    </div>
                </SidebarInset>
            </div>
        </SidebarProvider>
    );
};

export default ChatLoadingSkeleton;
