"use client";

import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Button } from "@neore/ui/components/button";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuGroup,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@neore/ui/components/responsive-dropdown-menu";
import { ChevronsUpDown, LogInIcon, PlusCircleIcon, SettingsIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useState } from "react";

import cn from "../utils/cn";

export interface OrgSwitcherOrganization {
    id: string;
    logo?: string;
    name: string;
    slug: string;
}

export interface OrgSwitcherUser {
    email: string;
    image?: string;
    name?: string;
}

export interface OrgSwitcherProps {
    activeOrgId?: null | string;
    className?: string;
    currentUser?: OrgSwitcherUser;
    hidePersonal?: boolean;
    isPending?: boolean;
    onCreateOrg?: () => void;
    onOpenSettings?: () => void;
    onSwitch: (orgId: null | string) => void;
    organizations?: OrgSwitcherOrganization[];
    size?: "default" | "icon" | "sm";
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Stable empty default so the prop identity does not change per render. */
const NO_ORGANIZATIONS: OrgSwitcherOrganization[] = [];

const WHITESPACE_RUN = /\s+/;

const getInitials = (name: string | undefined, fallback = "?"): string => {
    if (!name) {
        return fallback;
    }

    const parts = name.trim().split(WHITESPACE_RUN);

    if (parts.length >= 2) {
        return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
    }

    return name.slice(0, 2).toUpperCase();
};

// ─── OrgAvatar ────────────────────────────────────────────────────────────────

const OrgAvatar: FC<{
    className?: string;
    logo?: string;
    name: string;
}> = ({ className, logo, name }) => (
    <Avatar className={cn("size-5 rounded-md", className)}>
        {logo ? <AvatarImage alt={name} src={logo} /> : null}
        <AvatarFallback className="bg-primary/10 rounded-md text-[10px] font-semibold">{getInitials(name)}</AvatarFallback>
    </Avatar>
);

// ─── UserAvatar ───────────────────────────────────────────────────────────────

const UserAvatar: FC<{
    className?: string;
    user: OrgSwitcherUser;
}> = ({ className, user }) => (
    <Avatar className={cn("size-5", className)}>
        {user.image ? <AvatarImage alt={user.name ?? user.email} src={user.image} /> : null}
        <AvatarFallback name={user.name ?? user.email} />
    </Avatar>
);

// ─── OrgSwitcher ─────────────────────────────────────────────────────────────

const OrgSwitcher: FC<OrgSwitcherProps> = ({
    activeOrgId,
    className,
    currentUser,
    hidePersonal = false,
    isPending = false,
    onCreateOrg,
    onOpenSettings,
    onSwitch,
    organizations = NO_ORGANIZATIONS,
    size = "default",
}) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);

    // Derive active entity for display in trigger
    const activeOrg = activeOrgId ? organizations.find((o) => o.id === activeOrgId) : null;

    const triggerLabel = activeOrg?.name ?? currentUser?.name ?? currentUser?.email ?? t`Personal`;
    const isPersonal = !activeOrgId;

    // Items that can be switched to (exclude the active one)
    const switchableOrgs = organizations.filter((o) => o.id !== activeOrgId);
    const isShowPersonalOption = !hidePersonal && !isPersonal;

    const handleSwitch = useCallback(
        (orgId: null | string) => {
            onSwitch(orgId);
            setOpen(false);
        },
        [onSwitch],
    );

    const handleCreateOrg = useCallback(() => {
        onCreateOrg?.();
        setOpen(false);
    }, [onCreateOrg]);

    const handleOpenSettings = useCallback(() => {
        onOpenSettings?.();
        setOpen(false);
    }, [onOpenSettings]);

    // ── Trigger ────────────────────────────────────────────────────────────────

    let buttonSize: "default" | "icon" | "sm" = "default";

    if (size === "icon") {
        buttonSize = "icon";
    } else if (size === "sm") {
        buttonSize = "sm";
    }

    let triggerAvatar = null;

    if (activeOrg) {
        triggerAvatar = <OrgAvatar logo={activeOrg.logo} name={activeOrg.name} />;
    } else if (currentUser) {
        triggerAvatar = <UserAvatar user={currentUser} />;
    }

    const triggerContent = (
        <div className="flex min-w-0 items-center gap-2">
            {triggerAvatar}
            {size === "icon" ? <span className="sr-only">{triggerLabel}</span> : <span className="min-w-0 truncate text-xs font-medium">{triggerLabel}</span>}
            {size === "icon" ? null : <ChevronsUpDown aria-hidden="true" className="ml-auto size-3.5 shrink-0 opacity-40" />}
        </div>
    );

    return (
        <DropdownMenu onOpenChange={setOpen} open={open}>
            <DropdownMenuTrigger
                render={
                    <Button
                        aria-expanded={open}
                        aria-haspopup="menu"
                        aria-label={t`Switch workspace: currently ${triggerLabel}`}
                        className={cn(
                            "justify-start gap-2 px-2",
                            size === "icon" && "size-7 p-0",
                            size === "sm" && "h-6 px-1.5",
                            isPending && "pointer-events-none opacity-60",
                            className,
                        )}
                        disabled={isPending}
                        size={buttonSize}
                        variant="ghost"
                    >
                        {triggerContent}
                    </Button>
                }
            />

            <DropdownMenuContent align="start" className="w-56" sideOffset={4}>
                {/* Current account header */}
                {currentUser ? (
                    <>
                        <div className="flex items-center gap-2.5 px-2 py-2">
                            <UserAvatar user={currentUser} />
                            <div className="min-w-0 flex-1">
                                {currentUser.name ? <p className="truncate text-[12px] leading-tight font-medium">{currentUser.name}</p> : null}
                                <p className="text-muted-foreground truncate text-[11px]">{currentUser.email}</p>
                            </div>
                            {onOpenSettings ? (
                                <button
                                    aria-label={t`Open settings`}
                                    className="text-muted-foreground hover:text-foreground shrink-0 rounded p-0.5 transition-colors"
                                    onClick={handleOpenSettings}
                                    type="button"
                                >
                                    <SettingsIcon aria-hidden="true" className="size-3.5" />
                                </button>
                            ) : null}
                        </div>
                        <DropdownMenuSeparator />
                    </>
                ) : null}

                {/* Personal account option */}
                {isShowPersonalOption ? (
                    <DropdownMenuGroup>
                        <DropdownMenuItem onClick={() => handleSwitch(null)}>
                            {currentUser ? (
                                <UserAvatar user={currentUser} />
                            ) : (
                                <div aria-hidden="true" className="bg-muted flex size-5 items-center justify-center rounded-full">
                                    <LogInIcon className="text-muted-foreground size-3" />
                                </div>
                            )}
                            <span>{t`Personal`}</span>
                        </DropdownMenuItem>
                    </DropdownMenuGroup>
                ) : null}

                {/* Organization list */}
                {(isShowPersonalOption && switchableOrgs.length > 0) || (!isShowPersonalOption && organizations.length > 0) ? (
                    <>
                        {isShowPersonalOption && switchableOrgs.length > 0 ? <DropdownMenuSeparator /> : null}
                        <DropdownMenuGroup>
                            {(isShowPersonalOption ? switchableOrgs : organizations.filter((o) => o.id !== activeOrgId)).map((org) => (
                                <DropdownMenuItem key={org.id} onClick={() => handleSwitch(org.id)}>
                                    <OrgAvatar logo={org.logo} name={org.name} />
                                    <span className="truncate">{org.name}</span>
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuGroup>
                    </>
                ) : null}

                {/* Actions */}
                <DropdownMenuSeparator />
                <DropdownMenuGroup>
                    {onCreateOrg ? (
                        <DropdownMenuItem onClick={handleCreateOrg}>
                            <PlusCircleIcon aria-hidden="true" className="text-muted-foreground size-4" />
                            <span>{t`Create organization`}</span>
                        </DropdownMenuItem>
                    ) : null}
                    {onOpenSettings && !currentUser ? (
                        <DropdownMenuItem onClick={handleOpenSettings}>
                            <SettingsIcon aria-hidden="true" className="text-muted-foreground size-4" />
                            <span>{t`Settings`}</span>
                        </DropdownMenuItem>
                    ) : null}
                </DropdownMenuGroup>
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

OrgSwitcher.displayName = "OrgSwitcher";

export default OrgSwitcher;
