"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import cn from "@neore/ui/utils/cn";
import { formatDate } from "@neore/ui/utils/locale-format";
import { MonitorIcon, MoreHorizontalIcon, SmartphoneIcon, TabletIcon } from "lucide-react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";

interface Session {
    browser?: string;
    createdAt: string;
    deviceName?: string;
    deviceType: "mobile" | "tablet" | "desktop";
    id: string;
    ipAddress?: string;
    isCurrent: boolean;
    lastActiveAt: string;
    location?: string;
    os?: string;
}

interface SessionCellProperties {
    classNames?: SettingsCardClassNames;

    onRevokeSession?: (sessionId: string) => void;
    session: Session;
}

// Declared at module scope rather than picked during render: a component
// created inside render resets its state on every re-render and blocks the
// compiler from memoizing this cell.
const DeviceIcon = ({ className, deviceType }: { className?: string; deviceType: Session["deviceType"] }) => {
    switch (deviceType) {
        case "mobile": {
            return <SmartphoneIcon className={className} />;
        }
        case "tablet": {
            return <TabletIcon className={className} />;
        }
        default: {
            return <MonitorIcon className={className} />;
        }
    }
};

const SessionCell = ({ classNames, onRevokeSession, session }: SessionCellProperties) => {
    const [isRevoking, setIsRevoking] = useState(false);
    const { i18n, t } = useLingui();

    const lastActiveDate = formatDate(session.lastActiveAt, i18n.locale);

    const handleRevoke = async () => {
        if (!onRevokeSession || session.isCurrent) {
            return;
        }

        setIsRevoking(true);

        try {
            await onRevokeSession(session.id);
        } finally {
            setIsRevoking(false);
        }
    };

    return (
        <div className={cn("flex items-center justify-between rounded-lg border p-4", classNames?.content)}>
            <div className="flex items-center gap-3">
                <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg">
                    <DeviceIcon className="h-5 w-5" deviceType={session.deviceType} />
                </div>

                <div className="flex flex-col">
                    <div className="flex items-center gap-2">
                        <span className="font-medium">{session.deviceName || session.browser || t`Unknown Device`}</span>
                        {session.isCurrent && <span className="rounded-full bg-green-100 px-2 py-1 text-xs text-green-800">{t`Current`}</span>}
                    </div>
                    <div className="text-muted-foreground text-sm">
                        {session.os && `${session.os} • `}
                        {session.location && `${session.location} • `}
                        {t`Last active ${lastActiveDate}`}
                    </div>
                </div>
            </div>

            {!session.isCurrent && (
                <DropdownMenu>
                    <DropdownMenuTrigger
                        render={
                            <Button className="h-8 w-8" disabled={isRevoking} size="icon" variant="ghost">
                                <MoreHorizontalIcon className="h-4 w-4" />
                                <span className="sr-only">{t`More options`}</span>
                            </Button>
                        }
                    />

                    <DropdownMenuContent align="end">
                        <DropdownMenuItem className="text-destructive" disabled={isRevoking} onClick={handleRevoke}>
                            {isRevoking ? t`Revoking...` : t`Revoke Session`}
                        </DropdownMenuItem>
                    </DropdownMenuContent>
                </DropdownMenu>
            )}
        </div>
    );
};

export default SessionCell;
