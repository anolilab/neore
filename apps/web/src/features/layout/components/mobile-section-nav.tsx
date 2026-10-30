"use client";

import { useLingui } from "@lingui/react/macro";
import { useSidebar } from "@neore/ui/components/sidebar";
import cn from "@neore/ui/utils/cn";
import { Link, useLocation } from "@tanstack/react-router";
import { Cog, HelpCircle } from "lucide-react";
import type { FC } from "react";

import useChangelog from "@/features/changelog/hooks/use-changelog";
import useChangelogStore from "@/features/changelog/stores/changelog-store";
import { useNavLinks } from "@/features/layout/components/sidebar-shortcut";
import { useModalState } from "@/features/layout/hooks/use-ui-state";

const ROW =
    "flex min-h-11 w-full items-center gap-3 rounded-md px-3 text-sm transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-hidden";

/** Section navigation for phones, where the icon rail is hidden. Mirrors the rail's entries. */
const MobileSectionNav: FC = () => {
    const { t } = useLingui();
    const location = useLocation();
    const navLinks = useNavLinks();
    const { setState } = useSidebar("left");
    const closeSheet = () => setState({ isMobileOpen: false });
    const { open: openSettings } = useModalState("settings");
    const { unreadCount } = useChangelog();
    const openChangelogPanel = useChangelogStore((s) => s.open);

    return (
        <nav aria-label={t`Sections`} className="border-sidebar-border border-b px-2 pb-2">
            <ul className="flex flex-col gap-0.5">
                {navLinks.map(({ icon: Icon, matcher, shortLabelKey, to }) => {
                    const isActive = matcher(location.pathname);

                    return (
                        <li key={to}>
                            <Link
                                aria-current={isActive ? "page" : undefined}
                                className={cn(ROW, isActive ? "bg-sidebar-accent text-sidebar-accent-foreground" : "hover:bg-sidebar-accent/50")}
                                to={to}
                            >
                                <Icon aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.5} />
                                <span>{t(shortLabelKey)}</span>
                            </Link>
                        </li>
                    );
                })}
                <li>
                    <button
                        className={cn(ROW, "hover:bg-sidebar-accent/50")}
                        onClick={() => {
                            closeSheet();
                            openSettings();
                        }}
                        type="button"
                    >
                        <Cog aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.5} />
                        <span>{t`Settings`}</span>
                    </button>
                </li>
                <li>
                    <button
                        className={cn(ROW, "hover:bg-sidebar-accent/50")}
                        onClick={() => {
                            closeSheet();
                            openChangelogPanel();
                        }}
                        type="button"
                    >
                        <HelpCircle aria-hidden="true" className="size-5 shrink-0" strokeWidth={1.5} />
                        <span>{t`Help`}</span>
                        {unreadCount > 0 && <span aria-hidden="true" className="bg-destructive ml-auto size-2 rounded-full" />}
                    </button>
                </li>
            </ul>
        </nav>
    );
};

export default MobileSectionNav;
