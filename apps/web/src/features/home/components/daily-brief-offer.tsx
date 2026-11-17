"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sunrise } from "lucide-react";
import type { FC } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

type Scheduled = { nextBriefAt: number; timeZone: string };

/** The first brief's time in the zone it was planned in, which may not be the browser's. */
const formatArrival = (scheduled: Scheduled, locale: string): string =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: scheduled.timeZone, timeZoneName: "short", weekday: "long" }).format(
        scheduled.nextBriefAt,
    );

/**
 * The home page's one-time Daily Brief offer. `offered` comes from the overview
 * (`dailyBriefOffer`): the user never chose on or off, never said "Not now",
 * and has a few chats. Nothing turns on without the click. After "Turn it on"
 * the card stays to say when the first brief arrives, even though the overview
 * no longer offers it.
 */
const DailyBriefOffer: FC<{ offered: boolean }> = ({ offered }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const [scheduled, setScheduled] = useState<Scheduled | null>(null);
    const [turnedOn, setTurnedOn] = useState(false);
    const enable = useMutation(crpc.notifications.daily_brief.setDailyBriefEnabled.mutationOptions());
    const dismiss = useMutation(crpc.notifications.daily_brief.dismissDailyBriefOffer.mutationOptions());

    if (!offered && !turnedOn) {
        return null;
    }

    const busy = enable.isPending || dismiss.isPending;

    const turnOn = () => {
        enable.mutate(
            { enabled: true },
            {
                onSuccess: (result) => {
                    setScheduled(result);
                    setTurnedOn(true);
                },
            },
        );
    };

    return (
        <section aria-labelledby={headingId} className="bg-card text-card-foreground ring-foreground/10 flex flex-col gap-3 rounded-lg p-4 ring-1">
            <h2 className="flex items-center gap-2 text-base font-medium" id={headingId}>
                <Sunrise aria-hidden="true" className="size-4" />
                {t`Daily Brief`}
            </h2>
            {turnedOn ? (
                <div className="flex flex-wrap items-center justify-between gap-3 text-sm" role="status">
                    <p>
                        {scheduled
                            ? t`Daily Brief is on. Your first one arrives ${formatArrival(scheduled, i18n.locale)}.`
                            : t`Daily Brief is on. It arrives each morning.`}
                    </p>
                    <Link className="text-primary-text text-xs font-medium hover:underline" hash="daily-brief" to="/dashboard/settings/auth/account">
                        {t`Change it in settings`}
                    </Link>
                </div>
            ) : (
                <>
                    <p className="text-muted-foreground text-sm">
                        {t`Get a short summary each morning of what finished, what needs you and what is still running.`}
                    </p>
                    {(enable.isError || dismiss.isError) && (
                        <p className="text-destructive text-sm" role="alert">
                            {enable.isError ? t`Could not turn on the Daily Brief. Try again.` : t`Could not save your answer. Try again.`}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={busy} onClick={turnOn} size="sm">
                            {t`Turn it on`}
                        </Button>
                        <Button disabled={busy} onClick={() => dismiss.mutate({})} size="sm" variant="ghost">
                            {t`Not now`}
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
};

export default DailyBriefOffer;
