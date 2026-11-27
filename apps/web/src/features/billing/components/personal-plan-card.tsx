import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { useQuery } from "@tanstack/react-query";

import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import { useCRPC } from "@/lib/lunora/crpc";

import useBillingOptions from "../hooks/use-billing-options";
import useCheckout from "../hooks/use-checkout";

/** The caller's own plan: Pro is bought per user, independent of any organization. */
const PersonalPlanCard = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { data: plan, isPending } = useQuery(crpc.billing.checkout.getMyPlan.queryOptions({}));
    const { isPending: checkoutPending, openPortal, startCheckout } = useCheckout();
    const { yearly } = useBillingOptions();
    const isPro = plan?.baseTier === "pro";

    return (
        <SettingsCard description={t`Pro is your own plan: every model and 1,000 messages a day.`} isPending={isPending} title={t`Your plan`}>
            <SettingsRow
                control={
                    <>
                        <Badge variant={isPro ? "default" : "secondary"}>{isPro ? t`Pro` : t`Free`}</Badge>
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
                            <>
                                {yearly.pro ? (
                                    <Button
                                        disabled={checkoutPending}
                                        onClick={() => {
                                            void startCheckout("pro", "year");
                                        }}
                                        size="sm"
                                        type="button"
                                        variant="outline"
                                    >
                                        {t`Pay yearly`}
                                    </Button>
                                ) : null}
                                <Button
                                    disabled={checkoutPending}
                                    onClick={() => {
                                        void startCheckout("pro");
                                    }}
                                    size="sm"
                                    type="button"
                                >
                                    {yearly.pro ? t`Upgrade to Pro, monthly` : t`Upgrade to Pro`}
                                </Button>
                            </>
                        )}
                    </>
                }
                title={t`Current plan:`}
            />
        </SettingsCard>
    );
};

export default PersonalPlanCard;
