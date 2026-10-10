import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import { getLocalizedError } from "@/features/auth/lib/utilities";
import { useAction } from "@/lib/lunora/crpc";

/**
 * Creem checkout and customer portal. Pro is the caller's own plan; Team and
 * the organization portal act on the active organization (owner or admin).
 * Both answer with a hosted Creem URL, so success is a full-page redirect; a failure (not
 * an owner/admin, no organization, billing not configured) becomes a toast.
 */
const useCheckout = (): {
    isPending: boolean;
    openPortal: (subject: "organization" | "user") => Promise<void>;
    startCheckout: (plan: "pro" | "team") => Promise<void>;
    /** An error toast for a free-plan limit, with an "Upgrade" action that starts a Pro checkout. */
    upgradeToast: (message: string) => void;
} => {
    const { t } = useLingui();
    const createCheckout = useAction(api.billing.checkout.createCheckout);
    const openCustomerPortal = useAction(api.billing.checkout.openCustomerPortal);
    const [isPending, setIsPending] = useState(false);

    const redirectTo = useCallback(
        async (start: () => Promise<{ url: string }>) => {
            setIsPending(true);

            try {
                const { url } = await start();

                globalThis.location.assign(url);
            } catch (error) {
                toast.error(getLocalizedError({ error, t }));
                setIsPending(false);
            }
        },
        [t],
    );

    const startCheckout = useCallback(
        async (plan: "pro" | "team") => await redirectTo(async () => await createCheckout({ plan })),
        [createCheckout, redirectTo],
    );
    const openPortal = useCallback(
        async (subject: "organization" | "user") => await redirectTo(async () => await openCustomerPortal({ subject })),
        [openCustomerPortal, redirectTo],
    );

    const upgradeToast = useCallback(
        (message: string) => {
            toast.error(message, {
                action: {
                    label: t`Upgrade`,
                    onClick: () => {
                        void startCheckout("pro");
                    },
                },
            });
        },
        [startCheckout, t],
    );

    return { isPending, openPortal, startCheckout, upgradeToast };
};

export default useCheckout;
