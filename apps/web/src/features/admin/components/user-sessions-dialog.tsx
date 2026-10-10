"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { ScrollArea } from "@neore/ui/components/scroll-area";
import { Skeleton } from "@neore/ui/components/skeleton";
import { formatDateTime } from "@neore/ui/utils/locale-format";
import { Globe, Loader2, Monitor, Smartphone, Trash2 } from "lucide-react";

import { showError, showSuccess } from "@/lib/toast";

import { useRevokeAllUserSessions, useUserSessions } from "../hooks/use-admin";

const MOBILE_UA_RE = /mobile|android|iphone|ipad/i;
const BROWSER_UA_RE = /(chrome|firefox|safari|edge|opera)/i;
const OS_UA_RE = /(windows|mac|linux|android|ios)/i;

interface UserSessionsDialogProps {
    onOpenChange: (open: boolean) => void;
    open: boolean;
    userId: Id<"user">;
    userName: string;
}

/** `unknown` is the caller's translated fallback for a browser or OS the user agent does not name. */
const parseUserAgent = (userAgent: string | null | undefined, unknown: string) => {
    if (!userAgent) return { browser: unknown, device: "unknown" as const, os: unknown };

    const isMobile = MOBILE_UA_RE.test(userAgent);
    const browser = userAgent.match(BROWSER_UA_RE)?.[1];
    const os = userAgent.match(OS_UA_RE)?.[1];

    return {
        browser: browser ? browser.charAt(0).toUpperCase() + browser.slice(1).toLowerCase() : unknown,
        device: isMobile ? ("mobile" as const) : ("desktop" as const),
        os: os ? os.charAt(0).toUpperCase() + os.slice(1).toLowerCase() : unknown,
    };
};

const UserSessionsDialog = ({ onOpenChange, open, userId, userName }: UserSessionsDialogProps) => {
    const { i18n, t } = useLingui();

    const { data: sessions, isPending, refetch } = useUserSessions(userId);
    const revokeAll = useRevokeAllUserSessions();

    const handleRevokeAll = async () => {
        try {
            const result = await revokeAll.mutateAsync({
                userId,
            });

            showSuccess(t`Revoked ${result.revokedCount} sessions`);

            refetch();
        } catch (error: any) {
            showError(error.message || t`Failed to revoke sessions`);
        }
    };

    const activeSessions = sessions?.filter((s) => !s.isExpired) || [];
    const expiredSessions = sessions?.filter((s) => s.isExpired) || [];

    const sessionsBody =
        sessions && sessions.length > 0 ? (
            <div className="space-y-4">
                {activeSessions.length > 0 && (
                    <div>
                        <h4 className="mb-2 text-sm font-medium">{t`Active Sessions (${activeSessions.length})`}</h4>
                        <div className="space-y-2">
                            {activeSessions.map((session) => {
                                const { browser, device, os } = parseUserAgent(session.userAgent, t`Unknown`);
                                const expiresAt = formatDateTime(session.expiresAt, i18n.locale);
                                const createdAt = formatDateTime(session.createdAt, i18n.locale);

                                return (
                                    <div className="rounded-lg border p-3" key={session._id}>
                                        <div className="flex items-start justify-between">
                                            <div className="flex items-center gap-3">
                                                {device === "mobile" ? (
                                                    <Smartphone className="text-muted-foreground size-5" />
                                                ) : (
                                                    <Monitor className="text-muted-foreground size-5" />
                                                )}
                                                <div>
                                                    <div className="flex items-center gap-2">
                                                        <span className="font-medium">{t`${browser} on ${os}`}</span>
                                                        {session.impersonatedBy && <Badge variant="outline">{t`Impersonated`}</Badge>}
                                                    </div>
                                                    <div className="text-muted-foreground flex items-center gap-2 text-xs">
                                                        {session.ipAddress && (
                                                            <span className="flex items-center gap-1">
                                                                <Globe className="size-3" />
                                                                {session.ipAddress}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <div className="text-muted-foreground text-xs">
                                                        {t`Created: ${createdAt}`} ·{t`Expires: ${expiresAt}`}
                                                    </div>
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                )}

                {expiredSessions.length > 0 && (
                    <div>
                        <h4 className="text-muted-foreground mb-2 text-sm font-medium">{t`Expired Sessions (${expiredSessions.length})`}</h4>
                        <div className="space-y-2 opacity-60">
                            {expiredSessions.slice(0, 3).map((session) => {
                                const { browser, os } = parseUserAgent(session.userAgent, t`Unknown`);

                                return (
                                    <div className="rounded-lg border p-2 text-sm" key={session._id}>
                                        {t`${browser} on ${os}`}
                                    </div>
                                );
                            })}
                            {expiredSessions.length > 3 && (
                                <div className="text-muted-foreground text-sm">{t`+${expiredSessions.length - 3} more expired sessions`}</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        ) : (
            <div className="text-muted-foreground py-8 text-center">{t`No sessions found`}</div>
        );

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="max-w-2xl">
                <DialogHeader>
                    <DialogTitle>{t`Sessions for ${userName}`}</DialogTitle>
                    <DialogDescription>{t`View and manage active sessions. Revoking sessions will force the user to sign in again.`}</DialogDescription>
                </DialogHeader>

                <ScrollArea className="max-h-[400px]">
                    {isPending ? (
                        <div className="space-y-3">
                            {[1, 2, 3].map((i) => (
                                <Skeleton className="h-20 w-full" key={i} />
                            ))}
                        </div>
                    ) : (
                        sessionsBody
                    )}
                </ScrollArea>

                <DialogFooter>
                    <Button onClick={() => onOpenChange(false)} variant="outline">
                        {t`Close`}
                    </Button>
                    {activeSessions.length > 0 && (
                        <Button disabled={revokeAll.isPending} onClick={handleRevokeAll} variant="destructive">
                            {revokeAll.isPending && <Loader2 className="mr-2 size-4 animate-spin" />}
                            <Trash2 className="mr-2 size-4" />
                            {t`Revoke All Sessions`}
                        </Button>
                    )}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default UserSessionsDialog;
