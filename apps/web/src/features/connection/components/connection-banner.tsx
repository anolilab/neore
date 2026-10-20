"use client";

import { useLingui } from "@lingui/react/macro";
import { motion, useReducedMotion } from "motion/react";

import { useConnectionStatus } from "../hooks/use-connection-status";

/**
 * Shows while the browser is offline or the live connection is down. The
 * status element stays mounted and only its text changes, because a live
 * region inserted already filled is often not announced. It is placed above
 * the chat composer and tucked behind the composer card: it slides up from
 * behind the card's top edge when shown, and slides back under it when cleared.
 */
const ConnectionBanner = () => {
    const { t } = useLingui();
    const view = useConnectionStatus();
    const prefersReducedMotion = useReducedMotion();

    let message = "";

    if (view === "offline") {
        message = t`You are offline.`;
    } else if (view === "reconnecting") {
        message = t`Reconnecting to the server…`;
    }

    const isShown = message !== "";

    return (
        <motion.div
            animate={{ opacity: isShown ? 1 : 0, y: isShown ? 0 : "100%" }}
            aria-live="polite"
            className="absolute inset-x-3 bottom-[calc(100%-0.75rem)] z-0 rounded-t-lg bg-amber-500 px-4 pt-2 pb-5 text-center text-sm font-medium text-amber-950"
            initial={false}
            role="status"
            transition={{ duration: prefersReducedMotion ? 0 : 0.25, ease: "easeOut" }}
        >
            {message}
        </motion.div>
    );
};

export default ConnectionBanner;
