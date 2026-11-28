"use client";

import { useLingui } from "@lingui/react/macro";
import { CardContent } from "@neore/ui/components/card";
import { Switch } from "@neore/ui/components/switch";
import { skipToken, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { FC } from "react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import SettingsRow from "@/components/settings/settings-row";
import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useCRPC } from "@/lib/lunora/crpc";

import type { ChatToastEvent } from "../lib/chat-toasts";
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
    saved: boolean | null | undefined,
    mutation: SettingMutation,
    messages: { error: string; off: string; on: string },
    // What an absent value means: off for an opt-in setting, on for one that defaults on.
    absent = false,
): { checked: boolean; disabled: boolean; onCheckedChange: (checked: boolean) => void } => {
    const [pending, setPending] = useState<boolean | undefined>(undefined);
    // Each change gets a number: only the newest change may clear the switch when it fails. An older one failing must not
    // reset a newer change that is still on its way.
    const latestChange = useRef(0);
    const current = saved ?? absent;

    // Once the saved value catches up with the switch, the local value is no longer needed.
    useEffect(() => {
        if (pending !== undefined && current === pending) {
            setPending(undefined);
        }
    }, [pending, current]);

    return {
        checked: pending ?? current,
        disabled: mutation.isPending,
        onCheckedChange: (checked) => {
            latestChange.current += 1;

            const change = latestChange.current;

            setPending(checked);
            mutation.mutate(
                { enabled: checked },
                {
                    onError: () => {
                        if (latestChange.current === change) {
                            setPending(undefined);
                        }

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

    // The in-app toasts for chat events. Each defaults on: an absent setting keeps the toast.
    // One mutation observer per switch: a shared one would drop an earlier change's callbacks when a later change starts.
    // Until the settings load, an absent value is not yet known to mean on: the three switches stay off and disabled.
    const chatToastsLoaded = userSettings.data !== undefined;
    const chatToastOptions = crpc.notifications.chat_toast_settings.setChatToastEnabled.mutationOptions();
    const setChatFinishedToast = useMutation(chatToastOptions);
    const setChatFailedToast = useMutation(chatToastOptions);
    const setChatInputToast = useMutation(chatToastOptions);
    const chatToastMutation = (event: ChatToastEvent, observer: typeof setChatFinishedToast): SettingMutation => {
        return {
            isPending: observer.isPending,
            mutate: (variables, options) => observer.mutate({ enabled: variables.enabled, event }, options),
        };
    };
    const chatToastMessages = {
        error: t`Could not save the chat notification setting.`,
        off: t`Chat notification turned off`,
        on: t`Chat notification turned on`,
    };
    const chatFinishedToast = useOptimisticSetting(
        userSettings.data?.chatFinishedToastEnabled,
        chatToastMutation("finished", setChatFinishedToast),
        chatToastMessages,
        true,
    );
    const chatFailedToast = useOptimisticSetting(
        userSettings.data?.chatFailedToastEnabled,
        chatToastMutation("failed", setChatFailedToast),
        chatToastMessages,
        true,
    );
    const chatInputToast = useOptimisticSetting(
        userSettings.data?.chatInputToastEnabled,
        chatToastMutation("input", setChatInputToast),
        chatToastMessages,
        true,
    );

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
                <SettingsRow
                    control={
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
                    }
                    description={pushHint}
                    descriptionId="push-notifications-hint"
                    htmlFor="push-notifications"
                    title={t`Push notifications on this browser`}
                />
                <SettingsRow
                    control={
                        <Switch
                            aria-describedby="daily-brief-hint"
                            checked={dailyBrief.checked}
                            disabled={dailyBrief.disabled}
                            id="daily-brief"
                            onCheckedChange={dailyBrief.onCheckedChange}
                        />
                    }
                    description={t`A short summary each morning of what finished, what is running and what needs you. It counts toward your daily usage.`}
                    descriptionId="daily-brief-hint"
                    htmlFor="daily-brief"
                    title={t`Daily Brief`}
                />
                <SettingsRow
                    control={
                        <Switch
                            aria-describedby="task-email-hint"
                            checked={taskEmail.checked}
                            disabled={taskEmail.disabled}
                            id="task-email"
                            onCheckedChange={taskEmail.onCheckedChange}
                        />
                    }
                    description={t`Get an email with a link to the result when a task or trigger run finishes with one.`}
                    descriptionId="task-email-hint"
                    htmlFor="task-email"
                    title={t`Email when a task finishes`}
                />
                <SettingsRow
                    control={
                        <Switch
                            aria-describedby="chat-finished-toast-hint"
                            checked={chatToastsLoaded && chatFinishedToast.checked}
                            disabled={chatFinishedToast.disabled || !chatToastsLoaded}
                            id="chat-finished-toast"
                            onCheckedChange={chatFinishedToast.onCheckedChange}
                        />
                    }
                    description={t`Show a message in the app when a chat reply finishes.`}
                    descriptionId="chat-finished-toast-hint"
                    htmlFor="chat-finished-toast"
                    title={t`Chat finished`}
                />
                <SettingsRow
                    control={
                        <Switch
                            aria-describedby="chat-failed-toast-hint"
                            checked={chatToastsLoaded && chatFailedToast.checked}
                            disabled={chatFailedToast.disabled || !chatToastsLoaded}
                            id="chat-failed-toast"
                            onCheckedChange={chatFailedToast.onCheckedChange}
                        />
                    }
                    description={t`Show a message in the app when a chat reply fails.`}
                    descriptionId="chat-failed-toast-hint"
                    htmlFor="chat-failed-toast"
                    title={t`Chat failed`}
                />
                <SettingsRow
                    control={
                        <Switch
                            aria-describedby="chat-input-toast-hint"
                            checked={chatToastsLoaded && chatInputToast.checked}
                            disabled={chatInputToast.disabled || !chatToastsLoaded}
                            id="chat-input-toast"
                            onCheckedChange={chatInputToast.onCheckedChange}
                        />
                    }
                    description={t`Show a message in the app when a chat waits for your answer or your approval.`}
                    descriptionId="chat-input-toast-hint"
                    htmlFor="chat-input-toast"
                    title={t`Chat needs your input or approval`}
                />
            </CardContent>
        </SettingsCard>
    );
};

export default NotificationSettings;
