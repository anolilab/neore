"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Skeleton } from "@neore/ui/components/skeleton";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { Ban, Key, Shield, ShieldOff, Unlock, User, UserCheck, UserX } from "lucide-react";
import { useState } from "react";

import type { AuditLogAction } from "../hooks/use-admin";
import { useAuditLogs } from "../hooks/use-admin";
import { AdminRows, AdminSection } from "./admin-section";

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
    "admin.grant": <Shield aria-hidden="true" className="text-success size-4" />,
    "admin.revoke": <ShieldOff aria-hidden="true" className="text-attention size-4" />,
    "user.ban": <Ban aria-hidden="true" className="text-destructive size-4" />,
    "user.impersonate.start": <UserCheck aria-hidden="true" className="text-info size-4" />,
    "user.impersonate.stop": <UserX aria-hidden="true" className="text-info size-4" />,
    "user.role.update": <User aria-hidden="true" className="text-muted-foreground size-4" />,
    "user.sessions.revoke": <Key aria-hidden="true" className="text-attention size-4" />,
    "user.unban": <Unlock aria-hidden="true" className="text-success size-4" />,
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
            <AdminRows>
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
                        <div className="flex items-start gap-3 py-3" key={log._id}>
                            <div className="surface-well flex size-8 shrink-0 items-center justify-center rounded-lg">{ACTION_ICONS[action]}</div>

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
            </AdminRows>
        ) : (
            <div className="text-muted-foreground py-8 text-center text-sm">{t`No audit logs found`}</div>
        );

    return (
        <AdminSection
            action={
                <Select onValueChange={(value) => value && setActionFilter(value)} value={actionFilter}>
                    <SelectTrigger aria-label={t`Filter by action`} className="w-[180px]">
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
            }
            description={t`Track all admin actions for accountability`}
            title={t`Audit Log`}
        >
            {isPending ? (
                <AdminRows>
                    {[1, 2, 3, 4, 5].map((i) => (
                        <div className="flex items-center gap-3 py-3" key={i}>
                            <Skeleton className="size-8 rounded-lg" />
                            <div className="flex-1 space-y-2">
                                <Skeleton className="h-4 w-48" />
                                <Skeleton className="h-3 w-32" />
                            </div>
                        </div>
                    ))}
                </AdminRows>
            ) : (
                logsBody
            )}
        </AdminSection>
    );
};

export default AuditLogCard;
