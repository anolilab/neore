"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { WifiOff } from "lucide-react";

import { useOfflineScreen } from "../hooks/use-offline-screen";

/**
 * Full-screen cover for the native shell when the app has been unreachable for a while, in place of
 * a blank window. It overlays the routes and does not replace them, so page state survives. The
 * live region stays mounted and only the overlay is conditional, so the message is announced.
 */
const OfflineScreen = () => {
    const { t } = useLingui();
    const lapsedView = useOfflineScreen();

    let message = "";

    if (lapsedView === "offline") {
        message = t`You are offline. Neore will reconnect when the network is back.`;
    } else if (lapsedView === "reconnecting") {
        message = t`Neore cannot reach the server. It will keep trying to reconnect.`;
    }

    return (
        <div aria-live="polite" role="status">
            {message !== "" && (
                <div className="bg-background text-foreground fixed inset-0 z-[100] flex flex-col items-center justify-center gap-4 p-6 text-center">
                    <WifiOff aria-hidden="true" className="text-muted-foreground size-10" />
                    <p className="max-w-sm text-sm">{message}</p>
                    <Button onClick={() => globalThis.location.reload()} type="button" variant="outline">
                        {t`Try again`}
                    </Button>
                </div>
            )}
        </div>
    );
};

export default OfflineScreen;
