"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Label } from "@neore/ui/components/label";
import { Switch } from "@neore/ui/components/switch";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useCRPC } from "@/lib/lunora/crpc";

import type { PushSupport } from "../lib/web-push-client";
import { getCurrentPushSubscription, getPushSupport, subscribeBrowser, unsubscribeBrowser } from "../lib/web-push-client";

/**
 * Settings → Customization → Notifications: Web Push for this browser, and the
 * opt-in Daily Brief. Push is per browser (a subscription is a browser's), so
 * the switch is on only when THIS browser is subscribed AND the signed-in
 * account holds that subscription — a browser subscribed under another account
 * (or dropped server-side) reads off, and turning it on registers it here.
 */
type SettingMutation = {
    isPending: boolean;
    mutate: (variables: { enabled: boolean }, options: { onError: () => void; onSuccess: () => void }) => void;
};

/**
 * A saved on/off setting that flips at once. A failed save rolls it back and says
 * so; a saved one confirms with a toast.
 */
const useOptimisticSetting = (
    saved: boolean | undefined,
    mutation: SettingMutation,
    messages: { error: string; off: string; on: string },
): { checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void } => {
    const [pending, setPending] = useState<boolean | undefined>(undefined);

    return {
        checked: pending ?? saved === true,
        disabled: mutation.isPending,
        onCheckedChange: (checked) => {
            setPending(checked);
            mutation.mutate(
                { enabled: checked },
                {
                    onError: () => {
                        setPending(!checked);
                        toast.error(messages.error);
                    },
                    onSuccess: () => toast.success(checked ? messages.on : messages.off),
                },
            );
        },
    };
};

const NotificationSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const configQuery = crpc.notifications.push.getPushConfig.queryOptions({}, { live: false });
    const { data: config } = useQuery(configQuery);
    const userSettings = useUserSettings();
    const [support, setSupport] = useState<PushSupport>("unsupported");
    // This browser's subscription endpoint, if any — the server is asked whether it is this account's.
    const [endpoint, setEndpoint] = useState<string | undefined>(undefined);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        setSupport(getPushSupport());
        void getCurrentPushSubscription().then((subscription) => setEndpoint(subscription?.endpoint));
    }, []);

    const statusQuery = crpc.notifications.push.getPushSubscriptionStatus.queryOptions(endpoint ? { endpoint } : skipToken, { live: false });
    const { data: status } = useQuery(statusQuery);
    const subscribed = endpoint !== undefined && status?.subscribed === true;

    const refresh = {
        onSettled: async () => {
            await Promise.all([
                queryClient.invalidateQueries({ queryKey: configQuery.queryKey }),
                queryClient.invalidateQueries({ queryKey: statusQuery.queryKey }),
            ]);
        },
    };
    const subscribe = useMutation(crpc.notifications.push.subscribePush.mutationOptions(refresh));
    const unsubscribe = useMutation(crpc.notifications.push.unsubscribePush.mutationOptions(refresh));
    const setDailyBrief = useMutation(crpc.notifications.daily_brief.setDailyBriefEnabled.mutationOptions());

    const setTaskEmail = useMutation(crpc.notifications.task_email.setTaskEmailEnabled.mutationOptions());
    const taskEmail = useOptimisticSetting(userSettings.data?.taskEmailEnabled, setTaskEmail, {
        error: t`Could not save the email setting.`,
        off: t`Task emails turned off`,
        on: t`Task emails turned on`,
    });

    const pushAvailable = Boolean(config?.publicKey) && support === "supported";
    const dailyBrief = useOptimisticSetting(userSettings.data?.dailyBriefEnabled, setDailyBrief, {
        error: t`Could not save the Daily Brief setting.`,
        off: t`Daily Brief turned off`,
        on: t`Daily Brief turned on`,
    });

    const togglePush = async (checked: boolean): Promise<void> => {
        setBusy(true);

        try {
            if (checked) {
                const publicKey = config!.publicKey!;
                const subscribeHere = async () => {
                    const result = await subscribeBrowser(publicKey);

                    if ("reason" in result) {
                        return result;
                    }

                    const { taken } = await subscribe.mutateAsync(result.payload);

                    return taken ? { taken } : { endpoint: result.payload.endpoint };
                };
                let outcome = await subscribeHere();

                if ("taken" in outcome) {
                    // An account that never signed out on this browser still holds the
                    // endpoint; a fresh browser subscription comes with a new one.
                    await unsubscribeBrowser();
                    outcome = await subscribeHere();
                }

                if ("reason" in outcome) {
                    setSupport(outcome.reason);
                    toast.error(
                        outcome.reason === "denied"
                            ? t`Notifications are blocked for this site in your browser.`
                            : t`Push notifications are not available here.`,
                    );

                    return;
                }

                if ("taken" in outcome) {
                    throw new Error("The push endpoint is still held by another account");
                }

                setEndpoint(outcome.endpoint);
                toast.success(t`Push notifications are on for this browser`);
            } else {
                const dropped = await unsubscribeBrowser();

                if (dropped) {
                    await unsubscribe.mutateAsync({ endpoint: dropped });
                }

                setEndpoint(undefined);
                toast.success(t`Push notifications are off for this browser`);
            }
        } catch {
            toast.error(t`Could not change push notifications. Try again.`);
        } finally {
            setBusy(false);
        }
    };

    const pushHint = (() => {
        if (!config) {
            return "";
        }

        if (!config.publicKey) {
            return t`Push notifications are not configured on this server.`;
        }

        switch (support) {
            case "denied": {
                return t`Notifications are blocked for this site in your browser. Allow them in the site settings to turn this on.`;
            }
            case "no-service-worker":
            case "unsupported": {
                return t`This browser cannot receive push notifications here.`;
            }
            default: {
                return t`Get a system notification when a task finishes or something needs your approval, even with the app closed.`;
            }
        }
    })();

    return (
        <SettingsCard description={t`Choose how Neore tells you about finished work and things that need you.`} title={t`Notifications`}>
            <CardContent className="space-y-4">
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                        <Label className="text-base font-medium" htmlFor="push-notifications">
                            {t`Push notifications on this browser`}
                        </Label>
                        <p className="text-muted-foreground text-sm" id="push-notifications-hint">
                            {pushHint}
                        </p>
                    </div>
                    <Switch
                        aria-describedby="push-notifications-hint"
                        checked={pushAvailable && subscribed}
                        disabled={!pushAvailable || busy}
                        id="push-notifications"
                        onCheckedChange={(checked) => {
                            // `togglePush` reports its own failures.
                            togglePush(checked).catch(() => {});
                        }}
                    />
                </div>
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                        <Label className="text-base font-medium" htmlFor="daily-brief">
                            {t`Daily Brief`}
                        </Label>
                        <p className="text-muted-foreground text-sm" id="daily-brief-hint">
                            {t`A short summary each morning of what finished, what is running and what needs you. It counts toward your daily usage.`}
                        </p>
                    </div>
                    <Switch
                        aria-describedby="daily-brief-hint"
                        checked={dailyBrief.checked}
                        disabled={dailyBrief.disabled}
                        id="daily-brief"
                        onCheckedChange={dailyBrief.onCheckedChange}
                    />
                </div>
                <div className="flex items-center justify-between gap-4">
                    <div className="space-y-0.5">
                        <Label className="text-base font-medium" htmlFor="task-email">
                            {t`Email when a task finishes`}
                        </Label>
                        <p className="text-muted-foreground text-sm" id="task-email-hint">
                            {t`Get an email with a link to the result when a task or trigger run finishes with one.`}
                        </p>
                    </div>
                    <Switch
                        aria-describedby="task-email-hint"
                        checked={taskEmail.checked}
                        disabled={taskEmail.disabled}
                        id="task-email"
                        onCheckedChange={taskEmail.onCheckedChange}
                    />
                </div>
            </CardContent>
        </SettingsCard>
    );
};

export default NotificationSettings;
