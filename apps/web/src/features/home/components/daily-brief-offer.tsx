"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Sunrise } from "lucide-react";
import type { FC } from "react";
import { useEffect, useId, useRef } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

type Scheduled = { nextBriefAt: number; timeZone: string };

type Outcome = { kind: "dismissed" } | { kind: "on"; scheduled: Scheduled | null };

/** The first brief's time in the zone it was planned in, which may not be the browser's. */
const formatArrival = (scheduled: Scheduled, locale: string): string =>
    new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone: scheduled.timeZone, timeZoneName: "short", weekday: "long" }).format(
        scheduled.nextBriefAt,
    );

/** An organization lock refuses the write with `FORBIDDEN` (`auth/lib/preference-writes.ts`). */
const isManagedRefusal = (error: unknown): boolean => {
    const { code, data } = (typeof error === "object" && error !== null ? error : {}) as { code?: unknown; data?: { code?: unknown } };

    return (data?.code ?? code) === "FORBIDDEN";
};

/**
 * The home page's one-time Daily Brief offer. `offered` comes from the overview
 * (`dailyBriefOffer`): the user never chose on or off, never said "Not now",
 * and has a few chats. Nothing turns on without the click. An answer's write
 * makes the live overview stop offering it, possibly before the mutation
 * returns, so the card stays mounted from the click on (pending counts) and
 * confirms the answer, focused, inside a live region that was already there.
 * Its answer belongs to one account: the home page keys it by the signed-in
 * user, so an in-place account switch starts it over.
 */
const DailyBriefOffer: FC<{ offered: boolean }> = ({ offered }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const headingId = useId();
    const messageRef = useRef<HTMLParagraphElement>(null);
    const enable = useMutation(crpc.notifications.daily_brief.setDailyBriefEnabled.mutationOptions());
    const dismiss = useMutation(crpc.notifications.daily_brief.dismissDailyBriefOffer.mutationOptions());
    let outcome: Outcome | null = null;

    if (enable.isSuccess) {
        outcome = { kind: "on", scheduled: enable.data };
    } else if (dismiss.isSuccess) {
        outcome = { kind: "dismissed" };
    }

    const answered = outcome !== null;

    useEffect(() => {
        if (answered) {
            messageRef.current?.focus();
        }
    }, [answered]);

    const busy = enable.isPending || dismiss.isPending;
    // An organization lock withdraws the offer and refuses the write, so that refusal stays readable. Any other failure
    // after a withdrawal may be a lost reply to a saved answer: the card goes, rather than asking to try again.
    const managed = enable.isError && isManagedRefusal(enable.error);

    if (!offered && !answered && !busy && !managed) {
        return null;
    }

    // Only the latest attempt's failure is shown.
    const turnOn = () => {
        dismiss.reset();
        enable.mutate({ enabled: true });
    };

    const notNow = () => {
        enable.reset();
        dismiss.mutate({});
    };

    const confirmation = (current: Outcome): string => {
        if (current.kind === "dismissed") {
            return t`Okay, we won't ask again. You can turn it on any time in settings.`;
        }

        return current.scheduled
            ? t`Daily Brief is on. The next one is planned for ${formatArrival(current.scheduled, i18n.locale)}; a morning with nothing to report sends none.`
            : t`Daily Brief is on. It comes in the morning when there is something to report.`;
    };

    let failure: string | undefined;

    if (enable.isError) {
        failure = isManagedRefusal(enable.error) ? t`Your organization manages the Daily Brief.` : t`Could not turn on the Daily Brief. Try again.`;
    } else if (dismiss.isError) {
        failure = t`Could not save your answer. Try again.`;
    }

    return (
        <section aria-labelledby={headingId} className="bg-card text-card-foreground ring-foreground/10 flex flex-col gap-3 rounded-lg p-4 ring-1">
            <h2 className="flex items-center gap-2 text-base font-medium" id={headingId}>
                <Sunrise aria-hidden="true" className="size-4" />
                {t`Daily Brief`}
            </h2>
            <div role="status">
                {outcome && (
                    <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
                        <p
                            className="focus-visible:outline-ring rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2"
                            ref={messageRef}
                            tabIndex={-1}
                        >
                            {confirmation(outcome)}
                        </p>
                        <Link className="text-primary-text text-xs font-medium hover:underline" hash="daily-brief" to="/dashboard/settings/auth/account">
                            {outcome.kind === "on" ? t`Change it in settings` : t`Open settings`}
                        </Link>
                    </div>
                )}
            </div>
            {!outcome && (
                <>
                    <p className="text-muted-foreground text-sm">
                        {t`Get a short summary each morning of what finished, what needs you and what is still running. It counts toward your daily usage.`}
                    </p>
                    {failure && (
                        <p className="text-destructive text-sm" role="alert">
                            {failure}
                        </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                        <Button disabled={busy} onClick={turnOn} size="sm">
                            {t`Turn it on`}
                        </Button>
                        <Button disabled={busy} onClick={notNow} size="sm" variant="ghost">
                            {t`Not now`}
                        </Button>
                    </div>
                </>
            )}
        </section>
    );
};

export default DailyBriefOffer;
