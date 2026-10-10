"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Input } from "@neore/ui/components/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { Search, Users } from "lucide-react";
import { useState } from "react";

import type { SettingsCardProperties } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";

import { useAdminUsers } from "../hooks/use-admin";
import type { UserData } from "./user-cell";
import UserCell from "./user-cell";

interface UsersManagementCardProps extends Omit<SettingsCardProperties, "title" | "description"> {
    /**
     * Context for the user management - affects available actions
     */
    context?: "admin" | "organization";

    /**
     * Custom description override
     */
    description?: string;

    /**
     * Hide certain actions
     */
    hideActions?: boolean;

    /**
     * Callback when a user is updated (for refetching)
     */
    onUserUpdated?: () => void;

    /**
     * Custom title override
     */
    title?: string;
}

const UsersManagementCard = ({
    className,
    classNames,
    context = "admin",
    description,
    hideActions,
    onUserUpdated,
    title,
    ...properties
}: UsersManagementCardProps) => {
    const { t } = useLingui();

    const [search, setSearch] = useState("");
    const [roleFilter, setRoleFilter] = useState<"all" | "user" | "admin">("all");
    const [userTypeFilter, setUserTypeFilter] = useState<"all" | "user" | "anonymous">("all");

    const { data, isPending, refetch } = useAdminUsers({
        role: roleFilter,
        search: search || undefined,
        userType: userTypeFilter,
    });

    const handleUserUpdated = () => {
        refetch();
        onUserUpdated?.();
    };

    const cardTitle = title || t`User Management`;
    const cardDescription = description || t`View and manage all users in the system`;

    const usersBody =
        data?.page && data.page.length > 0 ? (
            <div className="divide-y">
                {data.page.map((user) => (
                    <UserCell classNames={classNames} hideActions={hideActions} key={user._id} onUserUpdated={handleUserUpdated} user={user as UserData} />
                ))}
            </div>
        ) : (
            <div className="text-muted-foreground flex flex-col items-center justify-center py-8">
                <Users className="mb-2 size-8 opacity-50" />
                <p>{search ? t`No users found matching "${search}"` : t`No users found`}</p>
            </div>
        );

    return (
        <SettingsCard
            className={className}
            classNames={classNames}
            description={cardDescription}
            instructions={context === "admin" ? t`Search, filter, and manage user roles and access` : undefined}
            isPending={isPending}
            title={cardTitle}
            {...properties}
        >
            <CardContent className={cn("space-y-4", classNames?.content)}>
                {/* Filters */}
                <div className="flex flex-col gap-3 sm:flex-row">
                    <div className="relative flex-1">
                        <Search className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2" />
                        <Input className="pl-9" onChange={(e) => setSearch(e.target.value)} placeholder={t`Search by name or email...`} value={search} />
                    </div>

                    <Select onValueChange={(v) => setRoleFilter(v as typeof roleFilter)} value={roleFilter}>
                        <SelectTrigger className="w-full sm:w-[150px]">
                            <SelectValue placeholder={t`Filter by role`} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{t`All Roles`}</SelectItem>
                            <SelectItem value="admin">{t`Admins Only`}</SelectItem>
                            <SelectItem value="user">{t`Users Only`}</SelectItem>
                        </SelectContent>
                    </Select>

                    <Select onValueChange={(v) => setUserTypeFilter(v as typeof userTypeFilter)} value={userTypeFilter}>
                        <SelectTrigger className="w-full sm:w-[150px]">
                            <SelectValue placeholder={t`Filter by type`} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{t`All Types`}</SelectItem>
                            <SelectItem value="user">{t`Regular Users`}</SelectItem>
                            <SelectItem value="anonymous">{t`Anonymous`}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>

                {/* User List */}
                {isPending ? (
                    <div className="space-y-3">
                        {[1, 2, 3, 4, 5].map((i) => (
                            <div className="flex items-center gap-3" key={i}>
                                <Skeleton className="size-10 rounded-full" />
                                <div className="flex-1 space-y-2">
                                    <Skeleton className="h-4 w-32" />
                                    <Skeleton className="h-3 w-48" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    usersBody
                )}

                {/* Pagination info */}
                {data && !data.isDone && (
                    <div className="text-muted-foreground text-center text-sm">{t`Showing ${data.page.length} users. More users available.`}</div>
                )}
            </CardContent>
        </SettingsCard>
    );
};

export default UsersManagementCard;
