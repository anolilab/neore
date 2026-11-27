"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { formatDate } from "@neore/ui/utils/locale-format";
import { Ban, Ghost, Key, MoreHorizontal, Shield, ShieldOff, Unlock, UserCheck, UserX } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";

import BanUserDialog from "./ban-user-dialog";
import ImpersonateUserDialog from "./impersonate-user-dialog";
import UpdateUserRoleDialog from "./update-user-role-dialog";
import UserSessionsDialog from "./user-sessions-dialog";

export interface UserData {
    _creationTime: number;
    _id: Id<"user">;
    banExpires?: number | null;
    banReason?: string | null;
    email: string;
    image?: string | null;
    isAdmin: boolean;
    isAnonymous: boolean;
    isBanned: boolean;
    name: string | null;
    role?: string | null;
}

interface UserCellProps {
    classNames?: SettingsCardClassNames;
    hideActions?: boolean;
    onUserUpdated?: () => void;
    user: UserData;
}

const UserCell = ({ classNames, hideActions, onUserUpdated, user }: UserCellProps) => {
    const { i18n, t } = useLingui();

    const [roleDialogOpen, setRoleDialogOpen] = useState(false);
    const [banDialogOpen, setBanDialogOpen] = useState(false);
    const [sessionsDialogOpen, setSessionsDialogOpen] = useState(false);
    const [impersonateDialogOpen, setImpersonateDialogOpen] = useState(false);

    const initials = user.name
        ? user.name
              .split(" ")
              .map((n) => n[0])
              .join("")
              .toUpperCase()
              .slice(0, 2)
        : user.email.slice(0, 2).toUpperCase();

    const createdDate = formatDate(user._creationTime, i18n.locale);

    return (
        <>
            <div className={cn("flex items-center justify-between gap-4 py-3", classNames?.cell)}>
                <div className="flex min-w-0 items-center gap-3">
                    <Avatar className="size-9">
                        <AvatarImage alt={user.name || user.email} src={user.image || undefined} />
                        <AvatarFallback name={user.name || user.email}>{initials}</AvatarFallback>
                    </Avatar>

                    <div className="flex min-w-0 flex-col gap-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{user.name || t`No name`}</span>
                            {user.isAnonymous && (
                                <Badge className="text-xs" variant="outline">
                                    <Ghost className="mr-1 size-3" />
                                    {t`Anonymous`}
                                </Badge>
                            )}
                            {user.isAdmin && (
                                <Badge className="text-xs" variant="secondary">
                                    <Shield className="mr-1 size-3" />
                                    {t`Admin`}
                                </Badge>
                            )}
                            {user.isBanned && (
                                <Badge className="text-xs" variant="destructive">
                                    <Ban className="mr-1 size-3" />
                                    {t`Banned`}
                                </Badge>
                            )}
                        </div>
                        <span className="text-muted-foreground truncate text-xs">{user.email}</span>
                        <span className="text-muted-foreground font-mono text-xs">{t`Joined ${createdDate}`}</span>
                    </div>
                </div>

                {!hideActions && (
                    <DropdownMenu>
                        {/* The icon and name go in the button itself: on a phone the menu draws only its `render`. */}
                        <DropdownMenuTrigger
                            render={
                                <Button size="icon" variant="ghost">
                                    <MoreHorizontal aria-hidden="true" className="size-4" />
                                    <span className="sr-only">{t`Open menu`}</span>
                                </Button>
                            }
                        />
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => setRoleDialogOpen(true)}>
                                {user.isAdmin ? (
                                    <>
                                        <ShieldOff className="mr-2 size-4" />
                                        {t`Remove Admin`}
                                    </>
                                ) : (
                                    <>
                                        <Shield className="mr-2 size-4" />
                                        {t`Make Admin`}
                                    </>
                                )}
                            </DropdownMenuItem>

                            <DropdownMenuItem onClick={() => setSessionsDialogOpen(true)}>
                                <Key className="mr-2 size-4" />
                                {t`View Sessions`}
                            </DropdownMenuItem>

                            {!user.isAdmin && !user.isBanned && (
                                <DropdownMenuItem onClick={() => setImpersonateDialogOpen(true)}>
                                    <UserCheck className="mr-2 size-4" />
                                    {t`Impersonate`}
                                </DropdownMenuItem>
                            )}

                            <DropdownMenuSeparator />

                            {user.isBanned ? (
                                <DropdownMenuItem className="text-success" onClick={() => setBanDialogOpen(true)}>
                                    <Unlock className="mr-2 size-4" />
                                    {t`Unban User`}
                                </DropdownMenuItem>
                            ) : (
                                <DropdownMenuItem className="text-destructive" onClick={() => setBanDialogOpen(true)}>
                                    <UserX className="mr-2 size-4" />
                                    {t`Ban User`}
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>

            <UpdateUserRoleDialog
                currentRole={user.isAdmin ? "admin" : "user"}
                onOpenChange={setRoleDialogOpen}
                onSuccess={onUserUpdated}
                open={roleDialogOpen}
                userId={user._id}
                userName={user.name || user.email}
            />

            <BanUserDialog
                isBanned={user.isBanned}
                onOpenChange={setBanDialogOpen}
                onSuccess={onUserUpdated}
                open={banDialogOpen}
                userId={user._id}
                userName={user.name || user.email}
            />

            <UserSessionsDialog onOpenChange={setSessionsDialogOpen} open={sessionsDialogOpen} userId={user._id} userName={user.name || user.email} />

            <ImpersonateUserDialog
                onOpenChange={setImpersonateDialogOpen}
                onSuccess={onUserUpdated}
                open={impersonateDialogOpen}
                userId={user._id}
                userName={user.name || user.email}
            />
        </>
    );
};

export default UserCell;
