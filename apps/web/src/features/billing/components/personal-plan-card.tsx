import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { useQuery } from "@tanstack/react-query";

import SettingsCard from "@/components/settings/settings-card";
import { useCRPC } from "@/lib/lunora/crpc";

import useCheckout from "../hooks/use-checkout";

/** The caller's own plan: Pro is bought per user, independent of any organization. */
const PersonalPlanCard = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: plan, isPending } = useQuery(crpc.billing.checkout.getMyPlan.queryOptions({}));
    const { isPending: checkoutPending, openPortal, startCheckout } = useCheckout();
    const isPro = plan?.baseTier === "pro";

    return (
        <SettingsCard description={t`Pro is your own plan: every model and 1,000 messages a day.`} isPending={isPending} title={t`Your plan`}>
            <CardContent className="flex items-center justify-between gap-4">
                <div className="text-muted-foreground text-sm">
                    {t`Current plan:`} <strong>{isPro ? t`Pro` : t`Free`}</strong>
                </div>
                {plan?.creemCustomerId ? (
                    <Button
                        disabled={checkoutPending}
                        onClick={() => {
                            void openPortal("user");
                        }}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        {t`Manage subscription`}
                    </Button>
                ) : null}
                {isPro || isPending ? null : (
                    <Button
                        disabled={checkoutPending}
                        onClick={() => {
                            void startCheckout("pro");
                        }}
                        size="sm"
                        type="button"
                    >
                        {t`Upgrade to Pro`}
                    </Button>
                )}
            </CardContent>
        </SettingsCard>
    );
};

export default PersonalPlanCard;
