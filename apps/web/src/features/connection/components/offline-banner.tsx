"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";

import { useConnection } from "../hooks/use-connection";

/**
 * A slim notice at the top of the chat layout while the browser is offline or
 * the live connection is down, and a short "Back online" once it returns. The
 * app stays on screen underneath. The status element stays mounted and only
 * its text changes, because a live region inserted already filled is often not
 * announced.
 */
const OfflineBanner = () => {
    const { t } = useLingui();
    const { backOnline, banner: view } = useConnection();

    let message = "";

    if (view === "offline") {
        message = t`Offline – reconnecting…`;
    } else if (view === "reconnecting") {
        message = t`Reconnecting to the server…`;
    } else if (backOnline) {
        message = t`Back online`;
    }

    return (
        <div
            aria-live="polite"
            className={cn(
                "pointer-events-none fixed top-2 left-1/2 z-50 -translate-x-1/2 rounded-full px-3 py-1 text-xs font-medium shadow-sm transition-[opacity,translate] duration-200 ease-out motion-reduce:transition-none",
                message === "" && "-translate-y-full opacity-0",
                view === "online" ? "bg-emerald-700 text-white" : "bg-amber-500 text-black",
            )}
            role="status"
        >
            {message}
        </div>
    );
};

export default OfflineBanner;
