"use client";

import { useLingui } from "@lingui/react/macro";
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from "@neore/ui/components/alert-dialog";
import { Button } from "@neore/ui/components/button";
import { WifiOff } from "lucide-react";

import { useOfflineScreen } from "../hooks/use-offline-screen";

const PROBE_TIMEOUT_MS = 5000;

/**
 * A reload while the network or the server is down replaces the app with the browser's error page, so
 * the button reloads only once the origin answers. A failed probe leaves the screen up.
 */
const reloadWhenReachable = async (): Promise<void> => {
    // A connection that opens and then stalls would otherwise leave the retry pending forever.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    try {
        const response = await fetch(globalThis.location.origin, { cache: "no-store", method: "HEAD", signal: controller.signal });

        if (response.ok) {
            globalThis.location.reload();
        }
    } catch {
        // Still unreachable, or the probe timed out: the screen stays up for another attempt.
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Full-screen cover for the native shell when the app has been unreachable for a while, in place of
 * a blank window. It overlays the routes and does not replace them, so page state survives. The
 * alert dialog takes focus and keeps it until the connection is back. The live region stays mounted
 * and only the dialog is conditional, so the message is announced.
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
            <AlertDialog open={message !== ""}>
                <AlertDialogContent className="bg-background text-foreground inset-0 top-0 left-0 z-[100] grid h-dvh max-w-none translate-x-0 translate-y-0 place-content-center justify-items-center gap-4 rounded-none p-6 text-center ring-0 data-[size=default]:max-w-none data-[size=default]:sm:max-w-none">
                    <WifiOff aria-hidden="true" className="text-muted-foreground size-10" />
                    <AlertDialogTitle className="max-w-sm text-sm font-normal">{message}</AlertDialogTitle>
                    <Button onClick={reloadWhenReachable} type="button" variant="outline">
                        {t`Try again`}
                    </Button>
                </AlertDialogContent>
            </AlertDialog>
        </div>
    );
};

export default OfflineScreen;
