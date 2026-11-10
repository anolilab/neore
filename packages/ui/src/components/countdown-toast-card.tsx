import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import cn from "@ui/utils/cn";
import { InfoIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { toastCloseButtonClass, toastDescriptionClass, toastIconClass, toastSurfaceClass, toastTextButtonClass, toastTitleClass } from "./toast-variants";

type CountdownToastTone = "neutral" | "destructive";

interface CountdownToastAction {
    label: string;
    onClick: () => void;
}

interface CountdownToastOptions {
    action?: CountdownToastAction;
    cancel?: CountdownToastAction;
    /** Footer text for a number of seconds left. Defaults to a localized "This message will close in N seconds". */
    countdownLabel?: (seconds: number) => string;
    description?: string;
    /** Milliseconds until the toast dismisses itself. Defaults to 10 seconds. */
    duration?: number;
    title: string;
    tone?: CountdownToastTone;
}

const DEFAULT_DURATION = 10_000;
const TICK_MS = 250;

interface CountdownToastCardProps extends CountdownToastOptions {
    id: number | string;
}

/**
 * Owns the clock. Sonner gets `duration: Infinity`, so it never closes this toast: the card counts down and
 * dismisses itself at zero. The clock pauses while the toast is expanded (hovered, same as sonner), while
 * focus is inside it, and while the document is hidden. Time is measured with `performance.now()`.
 */
const CountdownToastCard = ({
    action,
    cancel,
    countdownLabel,
    description,
    duration = DEFAULT_DURATION,
    id,
    title,
    tone = "neutral",
}: CountdownToastCardProps) => {
    const { t } = useLingui();
    const ref = useRef<HTMLDivElement>(null);
    const initialSeconds = Math.ceil(duration / 1000);
    const [seconds, setSeconds] = useState(initialSeconds);

    const label = countdownLabel ?? ((value: number) => t`This message will close in ${plural(value, { one: "# second", other: "# seconds" })}`);

    useEffect(() => {
        // Sonner's <li>, which holds this card. It is the focus target, and it is what sonner marks `data-expanded`
        // while the toaster is hovered (sonner 2 behaviour; check it on upgrade).
        const toastElement = ref.current?.closest<HTMLElement>("[data-sonner-toast]");
        let remainingMs = duration;
        let last = performance.now();
        let wasPaused = false;

        // A browser can freeze the interval while the tab is hidden, so no tick reports that time. Restart the
        // reference when the tab is visible again, so the hidden time is not counted.
        const onVisibilityChange = () => {
            if (!document.hidden) {
                last = performance.now();
            }
        };

        document.addEventListener("visibilitychange", onVisibilityChange);

        const timer = globalThis.setInterval(() => {
            const now = performance.now();
            const paused = toastElement?.dataset.expanded === "true" || document.hidden || (toastElement?.contains(document.activeElement) ?? false);

            // The first tick after a pause would count everything since the last paused tick, hidden time included.
            if (!paused && !wasPaused) {
                remainingMs -= now - last;
            }

            wasPaused = paused;
            last = now;

            if (remainingMs <= 0) {
                globalThis.clearInterval(timer);
                toast.dismiss(id);

                return;
            }

            setSeconds(Math.ceil(remainingMs / 1000));
        }, TICK_MS);

        return () => {
            globalThis.clearInterval(timer);
            document.removeEventListener("visibilitychange", onVisibilityChange);
        };
    }, [duration, id]);

    const destructive = tone === "destructive";

    // `finally`: a throwing handler still leaves the toast dismissed, so it does not stay on screen.
    const runAndDismiss = (button: CountdownToastAction) => () => {
        try {
            button.onClick();
        } finally {
            toast.dismiss(id);
        }
    };

    // `font-normal`: sonner's title wrapper is semibold, and the footer and description inherit from it.
    return (
        <div className={cn(toastSurfaceClass, "relative w-full overflow-hidden font-normal", destructive && "border-destructive/40")} ref={ref}>
            <div className="flex items-start gap-3 p-4 pe-9">
                <span aria-hidden="true" className={cn(toastIconClass, destructive && "bg-destructive/10 text-destructive")}>
                    <InfoIcon className="size-4" />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <p className={toastTitleClass}>{title}</p>
                    {description ? <p className={toastDescriptionClass}>{description}</p> : null}
                    {cancel || action ? (
                        <div className="mt-1 flex items-center gap-3">
                            {cancel ? (
                                <button
                                    className={cn(toastTextButtonClass, "font-medium text-muted-foreground hover:text-popover-foreground")}
                                    onClick={runAndDismiss(cancel)}
                                    type="button"
                                >
                                    {cancel.label}
                                </button>
                            ) : null}
                            {action ? (
                                <button
                                    className={cn(toastTextButtonClass, "font-semibold text-popover-foreground hover:underline")}
                                    onClick={runAndDismiss(action)}
                                    type="button"
                                >
                                    {action.label}
                                </button>
                            ) : null}
                        </div>
                    ) : null}
                </div>
            </div>
            <button aria-label={t`Close`} className={toastCloseButtonClass} onClick={() => toast.dismiss(id)} type="button">
                <XIcon aria-hidden="true" className="size-4" />
            </button>
            {/* Read once, when the toast appears. The ticking footer below is hidden from assistive tech. */}
            <p className="sr-only">{label(initialSeconds)}</p>
            <div
                aria-hidden="true"
                className={cn(
                    "border-t px-4 py-2 text-center text-sm tabular-nums",
                    destructive ? "border-destructive/20 bg-destructive/10 text-destructive" : "border-border bg-muted/50 text-muted-foreground",
                )}
            >
                {label(seconds)}
            </div>
        </div>
    );
};

export { CountdownToastCard };
export type { CountdownToastAction, CountdownToastOptions, CountdownToastTone };
