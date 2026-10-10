import { useLingui } from "@lingui/react/macro";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@neore/ui/components/responsive-alert-dialog";
import { useBlocker } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Workbox } from "workbox-window";

const SW_UPDATE_TOAST_ID = "sw-update-available";

/** Hoisted out of the hook body so the dynamic import stays outside the render function. */
const loadWorkbox = () => import("workbox-window");

const useRegisterSW = () => {
    const [needRefresh, setNeedRefresh] = useState(false);
    const [registration, setRegistration] = useState<ServiceWorkerRegistration | undefined>(undefined);
    const wb = useRef<Workbox | null>(null);

    const updateServiceWorker = useCallback(async () => {
        if (!wb.current) {
            return;
        }

        await wb.current.messageSkipWaiting();
        globalThis.location.reload();
    }, []);

    useEffect(() => {
        if (!("serviceWorker" in navigator) || import.meta.env.DEV) {
            return undefined;
        }

        const onWaiting = () => setNeedRefresh(true);

        let workbox: Workbox | undefined;

        const register = async () => {
            const { Workbox: WorkboxClass } = await loadWorkbox();

            workbox = new WorkboxClass("/sw.js", { scope: "/" });
            wb.current = workbox;

            workbox.addEventListener("waiting", onWaiting);

            setRegistration(await workbox.register());
        };

        void register().catch(() => {
            // Service worker registration is best-effort; the app works without it.
        });

        return () => {
            workbox?.removeEventListener("waiting", onWaiting);
        };
    }, []);

    return {
        needRefresh: [needRefresh, setNeedRefresh] as [boolean, React.Dispatch<React.SetStateAction<boolean>>],
        registration,
        updateServiceWorker,
    };
};

/**
 * Registers the service worker and prompts the user to reload when a new
 * app version is available.
 *
 * - Shows a persistent toast with a "Reload" action
 * - Blocks client-side navigation with an alert dialog requiring reload.
 */
const SwUpdatePrompt = () => {
    const { t } = useLingui();

    const { needRefresh: needRefreshState, registration, updateServiceWorker } = useRegisterSW();
    const [needRefresh] = needRefreshState;

    // Check for updates every 60 minutes while mounted.
    useEffect(() => {
        if (!registration) {
            return undefined;
        }

        const intervalId = setInterval(
            () => {
                registration.update().catch(() => {
                    // Silently ignore update check failures
                });
            },
            60 * 60 * 1000,
        );

        return () => clearInterval(intervalId);
    }, [registration]);

    // Block client-side navigation when an update is pending.
    const blocker = useBlocker({
        enableBeforeUnload: false,
        shouldBlockFn: () => needRefresh,
        withResolver: true,
    });

    // Show persistent toast when update becomes available
    useEffect(() => {
        if (!needRefresh) {
            return;
        }

        toast.info(t`A new version of the app is available.`, {
            action: {
                label: t`Reload`,
                onClick: () => updateServiceWorker(),
            },
            duration: Infinity,
            id: SW_UPDATE_TOAST_ID,
        });
    }, [needRefresh, updateServiceWorker, t]);

    if (!needRefresh) {
        return null;
    }

    const isBlocked = blocker.status === "blocked";

    return (
        <AlertDialog
            onOpenChange={(open) => {
                if (!open && blocker.status === "blocked") {
                    blocker.reset();
                }
            }}
            open={isBlocked}
        >
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>{t`Update required`}</AlertDialogTitle>
                    <AlertDialogDescription>{t`A new version of the app has been installed. Please reload the page to continue.`}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                    <AlertDialogAction onClick={() => updateServiceWorker()}>{t`Reload now`}</AlertDialogAction>
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    );
};

export default SwUpdatePrompt;
