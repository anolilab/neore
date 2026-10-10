"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Avatar, AvatarFallback, AvatarImage } from "@neore/ui/components/avatar";
import { Badge } from "@neore/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import { formatDate } from "@neore/ui/utils/locale-format";
import { Ban, Ghost, Shield, TrendingUp, User, Users } from "lucide-react";
import { useState } from "react";

import { useAdminDashboardStats } from "../hooks/use-admin";

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

interface StatCardProps {
    description: string;
    icon: React.ReactNode;
    title: string;
    value: number | string;
    variant?: "default" | "success" | "warning" | "danger";
}

const StatCard = ({ description, icon, title, value, variant = "default" }: StatCardProps) => {
    const variantStyles = {
        danger: "border-red-200 dark:border-red-900",
        default: "border-border",
        success: "border-green-200 dark:border-green-900",
        warning: "border-yellow-200 dark:border-yellow-900",
    };

    return (
        <Card className={cn("transition-shadow hover:shadow-md", variantStyles[variant])}>
            <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium">{title}</CardTitle>
                {icon}
            </CardHeader>
            <CardContent>
                <div className="text-2xl font-bold">{value}</div>
                <p className="text-muted-foreground text-xs">{description}</p>
            </CardContent>
        </Card>
    );
};

const AdminDashboardStats = () => {
    const { i18n, t } = useLingui();
    const { data: stats, isPending } = useAdminDashboardStats();
    const [growthFilter, setGrowthFilter] = useState<"all" | "regular" | "anonymous">("all");

    if (isPending) {
        return (
            <div className="space-y-6">
                {/* Stats grid skeleton */}
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                    {[1, 2, 3, 4, 5, 6].map((i) => (
                        <Card key={i}>
                            <CardHeader className="pb-2">
                                <Skeleton className="h-4 w-24" />
                            </CardHeader>
                            <CardContent>
                                <Skeleton className="mb-1 h-8 w-16" />
                                <Skeleton className="h-3 w-32" />
                            </CardContent>
                        </Card>
                    ))}
                </div>

                {/* Recent users skeleton */}
                <Card>
                    <CardHeader>
                        <Skeleton className="h-5 w-32" />
                        <Skeleton className="h-4 w-48" />
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-3">
                            {[1, 2, 3, 4, 5].map((i) => (
                                <div className="flex items-center gap-3" key={i}>
                                    <Skeleton className="size-8 rounded-full" />
                                    <div className="flex-1">
                                        <Skeleton className="mb-1 h-4 w-32" />
                                        <Skeleton className="h-3 w-24" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            </div>
        );
    }

    if (!stats) {
        return null;
    }

    return (
        <div className="space-y-6">
            {/* Stats Grid */}
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
                <StatCard
                    description={t`All accounts`}
                    icon={<Users className="text-muted-foreground size-4" />}
                    title={t`Total Users`}
                    value={stats.totalUsers}
                />

                <StatCard
                    description={t`With email/password`}
                    icon={<User className="text-muted-foreground size-4" />}
                    title={t`Regular Users`}
                    value={stats.totalRegularUsers}
                />

                <StatCard
                    description={t`Guest accounts`}
                    icon={<Ghost className="text-muted-foreground size-4" />}
                    title={t`Anonymous Users`}
                    value={stats.totalAnonymousUsers}
                />

                <StatCard
                    description={t`With admin privileges`}
                    icon={<Shield className="text-muted-foreground size-4" />}
                    title={t`Administrators`}
                    value={stats.totalAdmins}
                    variant="success"
                />

                <StatCard
                    description={t`Currently restricted`}
                    icon={<Ban className="text-muted-foreground size-4" />}
                    title={t`Banned Users`}
                    value={stats.totalBannedUsers}
                    variant={stats.totalBannedUsers > 0 ? "danger" : "default"}
                />

                <StatCard
                    description={t`New this week`}
                    icon={<TrendingUp className="text-muted-foreground size-4" />}
                    title={t`Weekly Growth`}
                    value={stats.userGrowth.all.reduce((sum: number, d: UserGrowthPoint) => sum + d.count, 0)}
                    variant="success"
                />
            </div>

            {/* User Growth Chart (simplified) */}
            <Card>
                <CardHeader className="flex flex-row items-center justify-between">
                    <div>
                        <CardTitle>{t`User Growth (Last 7 Days)`}</CardTitle>
                        <CardDescription>{t`New user registrations per day`}</CardDescription>
                    </div>
                    <Select onValueChange={(v) => setGrowthFilter(v as typeof growthFilter)} value={growthFilter}>
                        <SelectTrigger className="w-[140px]">
                            <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{t`All Users`}</SelectItem>
                            <SelectItem value="regular">{t`Regular`}</SelectItem>
                            <SelectItem value="anonymous">{t`Anonymous`}</SelectItem>
                        </SelectContent>
                    </Select>
                </CardHeader>
                <CardContent>
                    <div className="flex h-32 items-end gap-2">
                        {stats.userGrowth[growthFilter].map((day: UserGrowthPoint) => {
                            const maxCount = Math.max(...stats.userGrowth[growthFilter].map((d: UserGrowthPoint) => d.count), 1);
                            const height = (day.count / maxCount) * 100;
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
                                    <span className="text-muted-foreground text-xs">{dayName}</span>
                                    <span className="text-xs font-medium">{day.count}</span>
                                </div>
                            );
                        })}
                    </div>
                </CardContent>
            </Card>

            {/* Recent Users */}
            <Card>
                <CardHeader>
                    <CardTitle>{t`Recent Registrations`}</CardTitle>
                    <CardDescription>{t`Latest users who joined the platform`}</CardDescription>
                </CardHeader>
                <CardContent>
                    <div className="space-y-3">
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
                                <div className="flex items-center gap-3" key={user._id}>
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
                    </div>
                </CardContent>
            </Card>
        </div>
    );
};

export default AdminDashboardStats;
