import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import type { FC } from "react";

import { isDeviceOnline } from "@/features/devices/lib/device-relay";
import { isNativeShell } from "@/lib/native/bridge";

export type CodeHost = {
    _id: string;
    lastSeenAt?: number;
    name: string;
    platform: string;
};

/** What a Host tab shows: the paired device's name, platform, status and last contact. */
const HostDetails: FC<{ host: CodeHost; now: number }> = ({ host, now }) => {
    const { t } = useLingui();
    const online = isDeviceOnline(host.lastSeenAt, now);

    return (
        <div className="space-y-4 p-4">
            <h2 className="text-lg font-semibold">{host.name}</h2>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">
                    <Trans>Platform</Trans>
                </dt>
                <dd className="capitalize">{host.platform}</dd>
                <dt className="text-muted-foreground">
                    <Trans>Status</Trans>
                </dt>
                <dd>{online ? t`Online` : t`Offline`}</dd>
                <dt className="text-muted-foreground">
                    <Trans>Last seen</Trans>
                </dt>
                <dd>{host.lastSeenAt === undefined ? t`Never` : new Date(host.lastSeenAt).toLocaleString()}</dd>
            </dl>
            {isNativeShell() && (
                <Tooltip>
                    <TooltipTrigger render={<Button aria-disabled="true" className="opacity-50" variant="outline" />}>
                        <Trans>Open terminal</Trans>
                    </TooltipTrigger>
                    <TooltipContent>
                        <Trans>Available in the desktop app soon</Trans>
                    </TooltipContent>
                </Tooltip>
            )}
        </div>
    );
};

export default HostDetails;
