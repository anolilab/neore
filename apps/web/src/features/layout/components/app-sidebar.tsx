"use client";

import { useLingui } from "@lingui/react/macro";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarRail } from "@neore/ui/components/sidebar";
import MOBILE_BREAKPOINT_QUERY from "@neore/ui/utils/breakpoints";
import cn from "@neore/ui/utils/cn";
import { Link } from "@tanstack/react-router";
import { LogIn } from "lucide-react";
import type { ComponentProps, FC, ReactNode } from "react";
import { lazy, Suspense, useState } from "react";
import { useMediaMatch } from "rooks";

import AnonymousConvertCard from "@/features/auth/components/anonymous/anonymous-convert-card";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";
import NavUser from "@/features/layout/components/nav-user";
import SidebarShortcut from "@/features/layout/components/sidebar-shortcut";

const LoginModal = lazy(() => import("@/features/auth/components/auth/login-modal"));

const AppSidebar: FC<
    Omit<ComponentProps<typeof Sidebar>, "content" | "header"> & {
        content: ReactNode;
        footer?: ReactNode;
        header?: ReactNode;
    }
> = ({ className, content, footer, header }) => {
    const { t } = useLingui();
    const { isAnonymous } = useIsAnonymous();
    const isMobile = useMediaMatch(MOBILE_BREAKPOINT_QUERY);
    const [isLoginModalOpen, setIsLoginModalOpen] = useState(false);

    return (
        <>
            <SidebarShortcut />
            <Sidebar className={cn("left-16 [&>div]:flex-row", className)} collapsible="offcanvas" name="left" variant="inset">
                <div className="relative z-10 flex w-(--sidebar-width) flex-col rounded-l-xl">
                    <SidebarHeader>{header}</SidebarHeader>
                    <SidebarContent>{content}</SidebarContent>
                    <SidebarFooter>
                        {footer}
                        {isAnonymous ? (
                            <>
                                <AnonymousConvertCard />
                                {isMobile ? (
                                    <Link
                                        className="bg-primary text-primary-foreground hover:bg-primary/90 flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors"
                                        to="/auth/sign-in"
                                    >
                                        <LogIn className="size-4" />
                                        <span className="w-full text-center">{t`Login`}</span>
                                    </Link>
                                ) : (
                                    <>
                                        <button
                                            className="bg-primary text-primary-foreground hover:bg-primary/90 flex w-full items-center gap-2 rounded-lg px-3 py-2 transition-colors"
                                            onClick={(e) => {
                                                e.currentTarget.blur();
                                                setIsLoginModalOpen(true);
                                            }}
                                            type="button"
                                        >
                                            <LogIn className="size-4" />
                                            <span className="w-full text-center">{t`Login`}</span>
                                        </button>
                                        <Suspense>
                                            <LoginModal onOpenChange={setIsLoginModalOpen} open={isLoginModalOpen} />
                                        </Suspense>
                                    </>
                                )}
                            </>
                        ) : (
                            <NavUser />
                        )}
                    </SidebarFooter>
                </div>
                <SidebarRail className="in-data-[side=left]:left-[calc(var(--sidebar-width)+4.1rem)]" name="left" side="left" />
            </Sidebar>
        </>
    );
};

export default AppSidebar;
