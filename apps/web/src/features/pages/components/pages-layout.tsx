"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Sheet, SheetContent } from "@neore/ui/components/sheet";
import cn from "@neore/ui/utils/cn";
import { useLocation, useParams } from "@tanstack/react-router";
import { PanelLeft } from "lucide-react";
import type { FC, ReactNode } from "react";
import { createContext, use, useCallback, useMemo, useRef, useState } from "react";
import { useMediaMatch } from "rooks";

import PagesSidebar from "./pages-sidebar";

/** Tailwind's `lg`: from here the tree sits beside the page; below it the tree is a drawer (or the content, on the list). */
const WIDE_QUERY = "(min-width: 64rem)";

interface PagesDrawer {
    open: boolean;
    registerToggle: (element: HTMLButtonElement | null) => void;
    setOpen: (open: boolean) => void;
}

const PagesDrawerContext = createContext<PagesDrawer | null>(null);

/**
 * The button that opens the Pages tree as a drawer below `lg`. It lives in the page's header, which remounts for every page, so it
 * registers itself with the layout: after a pick closes the drawer, focus goes to whichever toggle is mounted by then.
 */
export const PagesSidebarToggle: FC<{ className?: string }> = ({ className }) => {
    const { t } = useLingui();
    const drawer = use(PagesDrawerContext);

    if (!drawer) {
        return null;
    }

    const { open, registerToggle, setOpen } = drawer;

    return (
        <Button
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={t`Pages`}
            className={cn("lg:hidden", className)}
            onClick={() => setOpen(true)}
            ref={registerToggle}
            size="icon-sm"
            variant="ghost"
        >
            <PanelLeft aria-hidden="true" />
        </Button>
    );
};

/** The Pages list itself: the tree is what there is to show there, so below `lg` it fills the screen. */
const isListPath = (pathname: string): boolean => pathname === "/pages" || pathname === "/pages/";

const PagesLayout: FC<{ children: ReactNode }> = ({ children }) => {
    const { t } = useLingui();
    const { pageId } = useParams({ strict: false }) as { pageId?: string };
    const pathname = useLocation({ select: (location) => location.pathname });
    const isWide = useMediaMatch(WIDE_QUERY);
    // The drawer belongs to the page it was opened on: picking another page closes it, and it stays closed on the way back.
    const pageKey = pageId ?? "";
    const [openedFor, setOpenedFor] = useState<string | null>(null);

    if (openedFor !== null && openedFor !== pageKey) {
        setOpenedFor(null);
    }

    const open = openedFor === pageKey && !isWide;
    const toggleRef = useRef<HTMLButtonElement | null>(null);
    const focusToggleWhenMounted = useRef(false);
    const treeIsContent = isListPath(pathname);

    const setOpen = useCallback(
        (next: boolean) => {
            focusToggleWhenMounted.current = false;
            setOpenedFor(next ? pageKey : null);
        },
        [pageKey],
    );

    const registerToggle = useCallback((element: HTMLButtonElement | null) => {
        toggleRef.current = element;

        if (element && focusToggleWhenMounted.current) {
            focusToggleWhenMounted.current = false;
            element.focus();
        }
    }, []);

    // Called when the drawer has closed: focus the toggle if it is there, else the next toggle to mount (the new page's header).
    const returnFocus = useCallback(() => {
        if (toggleRef.current?.isConnected) {
            return toggleRef.current;
        }

        focusToggleWhenMounted.current = true;

        return false;
    }, []);

    const drawer = useMemo<PagesDrawer>(() => {
        return { open, registerToggle, setOpen };
    }, [open, registerToggle, setOpen]);

    return (
        <PagesDrawerContext value={drawer}>
            <div className="flex h-full min-h-0 w-full">
                <PagesSidebar className={treeIsContent ? "max-lg:w-full max-lg:border-r-0" : "max-lg:hidden"} />
                <div className={cn("flex min-w-0 flex-1", treeIsContent && "max-lg:hidden")}>{children}</div>
            </div>
            <Sheet onOpenChange={setOpen} open={open}>
                <SheetContent
                    aria-label={t`Pages`}
                    className="gap-0 p-0"
                    finalFocus={returnFocus}
                    // Picking another page closes the drawer through the page id; picking the open one changes nothing, so close it here.
                    onClick={(event) => {
                        const link = event.target instanceof Element ? event.target.closest("a") : null;

                        if (link && link.pathname === pathname) {
                            setOpen(false);
                        }
                    }}
                    showCloseButton={false}
                    side="left"
                >
                    <PagesSidebar className="w-full flex-1 border-r-0 bg-transparent" />
                </SheetContent>
            </Sheet>
        </PagesDrawerContext>
    );
};

export default PagesLayout;
