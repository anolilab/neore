"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import { formatDate } from "@neore/ui/utils/locale-format";
import { Ban, Ghost, Shield, TrendingUp, User, Users } from "lucide-react";
import { useState } from "react";

import { useAdminDashboardStats } from "../hooks/use-admin";
import { AdminBlock, AdminRows, AdminSection, AdminStatGrid } from "./admin-section";

const STAT_COLUMNS = "@2xl:grid-cols-3 @5xl:grid-cols-6";

/**
 * Element shapes of `auth_admin.getDashboardStats`'s arrays, mirroring the
 * generated return type in `@neore/backend/api`. Spelled out so the callbacks
 * below stay typed regardless of how much of the return type the `crpc` shim
 * manages to propagate.
 */
interface UserGrowthPoint {
    count: number;
    date: string;
}

interface RecentUser {
    _creationTime: number;
    _id: string;
    email: string;
    image?: string | null;
    isAnonymous: boolean;
    name: string | null;
}

const AdminDashboardStats = () => {
    const { i18n, t } = useLingui();
    const { data: stats, isPending } = useAdminDashboardStats();
    const [growthFilter, setGrowthFilter] = useState<"all" | "regular" | "anonymous">("all");

    if (isPending) {
        return (
            <div className="flex flex-col gap-6">
                <AdminSection>
                    <AdminStatGrid
                        columns={STAT_COLUMNS}
                        stats={[1, 2, 3, 4, 5, 6].map((i) => {
                            return {
                                description: <Skeleton className="h-3 w-24" />,
                                id: String(i),
                                label: <Skeleton className="h-3 w-20" />,
                                value: <Skeleton className="h-8 w-16" />,
                            };
                        })}
                    />
                </AdminSection>

                <AdminSection description={<Skeleton className="h-4 w-48" />} title={<Skeleton className="h-5 w-32" />}>
                    <AdminRows>
                        {[1, 2, 3, 4, 5].map((i) => (
                            <div className="flex items-center gap-3 py-3" key={i}>
                                <Skeleton className="size-8 rounded-full" />
                                <div className="flex-1">
                                    <Skeleton className="mb-1 h-4 w-32" />
                                    <Skeleton className="h-3 w-24" />
                                </div>
                            </div>
                        ))}
                    </AdminRows>
                </AdminSection>
            </div>
        );
    }

    if (!stats) {
        return null;
    }

    const growthRows = stats.userGrowth[growthFilter];
    const maxGrowth = Math.max(...growthRows.map((d: UserGrowthPoint) => d.count), 1);

    return (
        <div className="flex flex-col gap-6">
            <AdminSection>
                <AdminStatGrid
                    columns={STAT_COLUMNS}
                    stats={[
                        {
                            description: t`All accounts`,
                            icon: <Users aria-hidden="true" className="size-3.5" />,
                            id: "total",
                            label: t`Total Users`,
                            value: stats.totalUsers,
                        },
                        {
                            description: t`With email/password`,
                            icon: <User aria-hidden="true" className="size-3.5" />,
                            id: "regular",
                            label: t`Regular Users`,
                            value: stats.totalRegularUsers,
                        },
                        {
                            description: t`Guest accounts`,
                            icon: <Ghost aria-hidden="true" className="size-3.5" />,
                            id: "anonymous",
                            label: t`Anonymous Users`,
                            value: stats.totalAnonymousUsers,
                        },
                        {
                            description: t`With admin privileges`,
                            icon: <Shield aria-hidden="true" className="size-3.5" />,
                            id: "admins",
                            label: t`Administrators`,
                            value: stats.totalAdmins,
                        },
                        {
                            description: t`Currently restricted`,
                            icon: <Ban aria-hidden="true" className="size-3.5" />,
                            id: "banned",
                            label: t`Banned Users`,
                            needsAttention: stats.totalBannedUsers > 0,
                            value: stats.totalBannedUsers,
                        },
                        {
                            description: t`New this week`,
                            icon: <TrendingUp aria-hidden="true" className="size-3.5" />,
                            id: "growth",
                            label: t`Weekly Growth`,
                            value: stats.userGrowth.all.reduce((sum: number, d: UserGrowthPoint) => sum + d.count, 0),
                        },
                    ]}
                />
            </AdminSection>

            {/* User Growth Chart (simplified) */}
            <AdminSection
                action={
                    <Select onValueChange={(v) => setGrowthFilter(v as typeof growthFilter)} value={growthFilter}>
                        <SelectTrigger aria-label={t`Filter by type`} className="w-[140px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{t`All Users`}</SelectItem>
                            <SelectItem value="regular">{t`Regular`}</SelectItem>
                            <SelectItem value="anonymous">{t`Anonymous`}</SelectItem>
                        </SelectContent>
                    </Select>
                }
                description={t`New user registrations per day`}
                title={t`User Growth (Last 7 Days)`}
            >
                <AdminBlock>
                    <div className="flex h-32 items-end gap-2">
                        {growthRows.map((day: UserGrowthPoint) => {
                            const height = (day.count / maxGrowth) * 100;
                            const date = new Date(day.date);
                            const dayName = formatDate(date, i18n.locale, { weekday: "short" });

                            return (
                                <div className="flex flex-1 flex-col items-center gap-1" key={day.date}>
                                    <div className="relative w-full">
                                        <div
                                            className="bg-primary/80 hover:bg-primary w-full rounded-t transition-[height,background-color]"
                                            style={{ height: `${Math.max(height, 4)}px` }}
                                            title={t`${plural(day.count, { one: "# user", other: "# users" })}`}
                                        />
                                    </div>
                                    <span className="text-muted-foreground font-mono text-xs">{dayName}</span>
                                    <span className="text-xs font-medium">{day.count}</span>
                                </div>
                            );
                        })}
                    </div>
                </AdminBlock>
            </AdminSection>

            {/* Recent Users */}
            <AdminSection description={t`Latest users who joined the platform`} title={t`Recent Registrations`}>
                <AdminRows>
                    {stats.recentUsers.map((user: RecentUser) => {
                        const initials = user.name
                            ? user.name
                                  .split(" ")
                                  .map((n) => n[0])
                                  .join("")
                                  .toUpperCase()
                                  .slice(0, 2)
                            : user.email.slice(0, 2).toUpperCase();

                        const joinedDate = formatDate(user._creationTime, i18n.locale, {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                        });

                        return (
                            <div className="flex items-center gap-3 py-3" key={user._id}>
                                <Avatar className="size-8">
                                    <AvatarImage alt={user.name || user.email} src={user.image || undefined} />
                                    <AvatarFallback className="text-xs" name={user.name || user.email}>
                                        {initials}
                                    </AvatarFallback>
                                </Avatar>
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-2">
                                        <p className="truncate text-sm font-medium">{user.name || t`No name`}</p>
                                        {user.isAnonymous && (
                                            <Badge className="shrink-0 text-xs" variant="outline">
                                                <Ghost className="mr-1 size-3" />
                                                {t`Anonymous`}
                                            </Badge>
                                        )}
                                    </div>
                                    <p className="text-muted-foreground truncate text-xs">{user.email}</p>
                                </div>
                                <span className="text-muted-foreground text-xs whitespace-nowrap">{joinedDate}</span>
                            </div>
                        );
                    })}
                </AdminRows>
            </AdminSection>
        </div>
    );
};

export default AdminDashboardStats;
