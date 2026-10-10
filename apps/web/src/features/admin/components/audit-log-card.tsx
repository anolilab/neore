"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { Ban, Key, Shield, ShieldOff, Unlock, User, UserCheck, UserX } from "lucide-react";
import { useState } from "react";

import type { AuditLogAction } from "../hooks/use-admin";
import { useAuditLogs } from "../hooks/use-admin";

type AuditAction =
    | "user.role.update"
    | "user.ban"
    | "user.unban"
    | "user.sessions.revoke"
    | "user.impersonate.start"
    | "user.impersonate.stop"
    | "admin.grant"
    | "admin.revoke";

const ACTION_LABELS: Record<AuditAction, MessageDescriptor> = {
    "admin.grant": msg`Admin Granted`,
    "admin.revoke": msg`Admin Revoked`,
    "user.ban": msg`User Banned`,
    "user.impersonate.start": msg`Impersonation Started`,
    "user.impersonate.stop": msg`Impersonation Stopped`,
    "user.role.update": msg`Role Updated`,
    "user.sessions.revoke": msg`Sessions Revoked`,
    "user.unban": msg`User Unbanned`,
};

const ACTION_ICONS: Record<AuditAction, React.ReactNode> = {
    "admin.grant": <Shield className="size-4 text-green-500" />,
    "admin.revoke": <ShieldOff className="size-4 text-orange-500" />,
    "user.ban": <Ban className="size-4 text-red-500" />,
    "user.impersonate.start": <UserCheck className="size-4 text-blue-500" />,
    "user.impersonate.stop": <UserX className="size-4 text-blue-500" />,
    "user.role.update": <User className="size-4 text-purple-500" />,
    "user.sessions.revoke": <Key className="size-4 text-yellow-500" />,
    "user.unban": <Unlock className="size-4 text-green-500" />,
};

const ACTION_VARIANTS: Record<AuditAction, "default" | "secondary" | "destructive" | "outline"> = {
    "admin.grant": "default",
    "admin.revoke": "secondary",
    "user.ban": "destructive",
    "user.impersonate.start": "outline",
    "user.impersonate.stop": "outline",
    "user.role.update": "secondary",
    "user.sessions.revoke": "secondary",
    "user.unban": "default",
};

const AuditLogCard = () => {
    const { i18n, t } = useLingui();

    // `AuditLogAction | "all"`, not `string`: the backend declares `action` as a
    // literal union and codegen now inlines it, so a free `string` no longer
    // assigns. The filter can only hold values the API accepts.
    const [actionFilter, setActionFilter] = useState<AuditLogAction | "all">("all");

    const { data, isPending } = useAuditLogs({
        action: actionFilter === "all" ? undefined : actionFilter,
        limit: 50,
    });

    const logsBody =
        data?.logs && data.logs.length > 0 ? (
            <div className="space-y-3">
                {data.logs.map((log) => {
                    const action = log.action as AuditAction;
                    const timestamp = formatDateTime(log.timestamp, i18n.locale);
                    let details: Record<string, unknown> | null = null;

                    try {
                        details = log.details ? JSON.parse(log.details) : null;
                    } catch {
                        // Ignore parse errors
                    }

                    return (
                        <div className="flex items-start gap-3 border-b pb-3 last:border-0" key={log._id}>
                            <div className="bg-muted flex size-8 items-center justify-center rounded-full">{ACTION_ICONS[action]}</div>

                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-2">
                                    <Badge variant={ACTION_VARIANTS[action]}>{i18n._(ACTION_LABELS[action])}</Badge>
                                    <span className="text-muted-foreground text-xs">{timestamp}</span>
                                </div>

                                <div className="mt-1 text-sm">
                                    <span className="font-medium">{log.adminEmail}</span>
                                    {log.targetUserEmail && (
                                        <>
                                            <span className="text-muted-foreground"> → </span>
                                            <span className="font-medium">{log.targetUserEmail}</span>
                                        </>
                                    )}
                                </div>

                                {details && (
                                    <div className="text-muted-foreground mt-1 text-xs">
                                        {Object.entries(details).map(([key, value]) => (
                                            <span className="mr-2" key={key}>
                                                {key}:{String(value)}
                                            </span>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>
                    );
                })}
            </div>
        ) : (
            <div className="text-muted-foreground py-8 text-center">{t`No audit logs found`}</div>
        );

    return (
        <Card>
            <CardHeader>
                <div className="flex items-center justify-between">
                    <div>
                        <CardTitle>{t`Audit Log`}</CardTitle>
                        <CardDescription>{t`Track all admin actions for accountability`}</CardDescription>
                    </div>

                    <Select onValueChange={(value) => value && setActionFilter(value)} value={actionFilter}>
                        <SelectTrigger className="w-[180px]">
                            <SelectValue placeholder={t`Filter by action`} />
                        </SelectTrigger>
                        <SelectContent>
                            <SelectItem value="all">{t`All Actions`}</SelectItem>
                            <SelectItem value="user.role.update">{t`Role Updates`}</SelectItem>
                            <SelectItem value="user.ban">{t`Bans`}</SelectItem>
                            <SelectItem value="user.unban">{t`Unbans`}</SelectItem>
                            <SelectItem value="user.sessions.revoke">{t`Session Revocations`}</SelectItem>
                            <SelectItem value="user.impersonate.start">{t`Impersonation Start`}</SelectItem>
                            <SelectItem value="user.impersonate.stop">{t`Impersonation Stop`}</SelectItem>
                            <SelectItem value="admin.grant">{t`Admin Grants`}</SelectItem>
                            <SelectItem value="admin.revoke">{t`Admin Revocations`}</SelectItem>
                        </SelectContent>
                    </Select>
                </div>
            </CardHeader>

            <CardContent>
                {isPending ? (
                    <div className="space-y-3">
                        {[1, 2, 3, 4, 5].map((i) => (
                            <div className="flex items-center gap-3" key={i}>
                                <Skeleton className="size-8 rounded-full" />
                                <div className="flex-1 space-y-2">
                                    <Skeleton className="h-4 w-48" />
                                    <Skeleton className="h-3 w-32" />
                                </div>
                            </div>
                        ))}
                    </div>
                ) : (
                    logsBody
                )}
            </CardContent>
        </Card>
    );
};

export default AuditLogCard;
