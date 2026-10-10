"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import cn from "@neore/ui/utils/cn";
import clsx from "clsx";
import { UAParser } from "my-ua-parser";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";
import SettingsCard from "@/components/settings/settings-card";
import { useListSessions } from "@/features/auth/hooks/session-management";
import { useSession } from "@/features/auth/hooks/session-user-management";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";

import SessionCell from "./session-cell";

export interface SessionsCardProperties {
    className?: string;
    classNames?: SettingsCardClassNames;
}

const parseUserAgent = (userAgent: string | null | undefined) => {
    if (!userAgent) {
        return {
            browser: undefined,
            deviceName: undefined,
            deviceType: "desktop" as const,
            os: undefined,
        };
    }

    const parser = new UAParser(userAgent);
    const result = parser.getResult();

    // Determine device type based on parsed data
    let deviceType: "mobile" | "tablet" | "desktop" = "desktop";

    if (result.device?.type === "mobile") {
        deviceType = "mobile";
    } else if (result.device?.type === "tablet") {
        deviceType = "tablet";
    }

    return {
        browser: result.browser?.name && result.browser.version ? `${result.browser.name} ${result.browser.version}` : result.browser?.name,
        deviceName: result.device?.model || result.device?.vendor,
        deviceType,
        os: result.os?.name && result.os.version ? `${result.os.name} ${result.os.version}` : result.os?.name,
    };
};

const SessionsCard = ({ className, classNames }: SessionsCardProperties) => {
    const {
        authClient,
        mutators: { revokeSession },
        toast,
    } = useAuth();
    const { t } = useLingui();

    const { data: sessions, isPending, refetch } = useListSessions(authClient);
    const { data: currentSession } = useSession(authClient);

    const handleRevokeSession = async (sessionToken: string) => {
        try {
            await revokeSession({ token: sessionToken });
            refetch?.();
        } catch {
            toast({
                message: t`Failed to revoke session`,
                variant: "error",
            });
        }
    };

    return (
        <SettingsCard
            className={clsx(className, "pb-6")}
            classNames={classNames}
            description={t`Manage your active sessions`}
            isPending={isPending}
            title={t`Sessions`}
        >
            <CardContent className={cn("grid gap-4", classNames?.content)}>
                {isPending ? (
                    <div className={cn("flex items-center justify-between rounded-lg border p-4", classNames?.content)}>
                        <div className="flex items-center gap-3">
                            <Skeleton className={cn("h-10 w-10 rounded-lg", classNames?.skeleton)} />
                            <div className="flex flex-col gap-2">
                                <Skeleton className={cn("h-4 w-24", classNames?.skeleton)} />
                                <Skeleton className={cn("h-3 w-32", classNames?.skeleton)} />
                            </div>
                        </div>
                        <Skeleton className={cn("h-8 w-8 rounded", classNames?.skeleton)} />
                    </div>
                ) : (
                    sessions?.map((session) => {
                        const isCurrent = session.id === currentSession?.session?.id;
                        const parsedUA = parseUserAgent(session.userAgent);

                        // Convert createdAt to Date if it's not already (handles both number timestamps and Date objects)
                        const createdAtDate = session.createdAt instanceof Date ? session.createdAt : new Date(session.createdAt);
                        // `lastActiveAt` is not part of better-auth's core session record; read it
                        // defensively so deployments that add it are honoured, else fall back.
                        const rawLastActiveAt = (session as typeof session & { lastActiveAt?: Date | number | string }).lastActiveAt ?? session.updatedAt;
                        const parsedLastActiveAt = rawLastActiveAt ? new Date(rawLastActiveAt) : createdAtDate;
                        const lastActiveAtDate = rawLastActiveAt instanceof Date ? rawLastActiveAt : parsedLastActiveAt;

                        // Transform the session data to match SessionCell's expected format
                        const sessionData = {
                            browser: parsedUA.browser,
                            createdAt: createdAtDate.toISOString(),
                            deviceName: parsedUA.deviceName,
                            deviceType: parsedUA.deviceType,
                            id: session.id,
                            ipAddress: session.ipAddress || undefined,
                            isCurrent,
                            lastActiveAt: lastActiveAtDate.toISOString(),
                            os: parsedUA.os,
                        };

                        return (
                            <SessionCell
                                classNames={classNames}
                                key={session.id}
                                onRevokeSession={() => handleRevokeSession(session.token)}
                                session={sessionData}
                            />
                        );
                    })
                )}
            </CardContent>
        </SettingsCard>
    );
};

export default SessionsCard;
