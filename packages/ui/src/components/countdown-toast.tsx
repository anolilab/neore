import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { InfoIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import cn from "@ui/utils/cn";

type CountdownToastTone = "neutral" | "destructive";

interface CountdownToastAction {
    label: string;
    onClick: () => void;
}

interface CountdownToastOptions {
    title: string;
    description?: string;
    tone?: CountdownToastTone;
    /** Milliseconds until the toast dismisses itself. Defaults to 5 seconds. */
    duration?: number;
    action?: CountdownToastAction;
    cancel?: CountdownToastAction;
    /** Footer text for a number of seconds left. Defaults to a localized "This message will close in N seconds". */
    countdownLabel?: (seconds: number) => string;
}

const DEFAULT_DURATION = 5000;
const TICK_MS = 250;

const textButtonClass = "rounded-sm text-sm underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring";

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
        let remainingMs = duration;
        let last = performance.now();

        const timer = window.setInterval(() => {
            const now = performance.now();
            const expanded = ref.current?.closest("[data-sonner-toast]")?.getAttribute("data-expanded") === "true";
            const paused = expanded || document.hidden || (ref.current?.contains(document.activeElement) ?? false);

            if (!paused) {
                remainingMs -= now - last;
            }

            last = now;

            if (remainingMs <= 0) {
                window.clearInterval(timer);
                toast.dismiss(id);

                return;
            }

            setSeconds(Math.ceil(remainingMs / 1000));
        }, TICK_MS);

        return () => window.clearInterval(timer);
    }, [duration, id]);

    const destructive = tone === "destructive";

    const runAndDismiss = (button: CountdownToastAction) => () => {
        button.onClick();
        toast.dismiss(id);
    };

    return (
        <div
            className={cn(
                "relative w-full overflow-hidden rounded-lg border bg-popover text-popover-foreground shadow-md",
                destructive ? "border-destructive/40" : "border-border",
            )}
            ref={ref}
        >
            <div className="flex items-start gap-3 p-4 pe-9">
                <span
                    aria-hidden="true"
                    className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-md",
                        destructive ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground",
                    )}
                >
                    <InfoIcon className="size-4" />
                </span>
                <div className="flex min-w-0 flex-col gap-0.5">
                    <p className="text-sm leading-5 font-semibold">{title}</p>
                    {description ? <p className="text-muted-foreground text-sm leading-5">{description}</p> : null}
                    {cancel || action ? (
                        <div className="mt-1 flex items-center gap-3">
                            {cancel ? (
                                <button
                                    className={cn(textButtonClass, "font-medium text-muted-foreground hover:text-popover-foreground")}
                                    onClick={runAndDismiss(cancel)}
                                    type="button"
                                >
                                    {cancel.label}
                                </button>
                            ) : null}
                            {action ? (
                                <button
                                    className={cn(textButtonClass, "font-semibold text-popover-foreground hover:underline")}
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
            <button
                aria-label={t`Close`}
                className="text-muted-foreground hover:bg-muted hover:text-popover-foreground focus-visible:ring-ring absolute end-2 top-2 flex size-7 items-center justify-center rounded-md transition-colors outline-none focus-visible:ring-2"
                onClick={() => toast.dismiss(id)}
                type="button"
            >
                <XIcon aria-hidden="true" className="size-4" />
            </button>
            {/* Read once, when the toast appears. The ticking footer below is hidden from assistive tech. */}
            <p className="sr-only">{label(initialSeconds)}</p>
            <div
                aria-hidden="true"
                className={cn(
                    "border-t px-4 py-2 text-center text-sm",
                    destructive ? "border-destructive/20 bg-destructive/10 text-destructive" : "border-border bg-muted/50 text-muted-foreground",
                )}
            >
                {label(seconds)}
            </div>
        </div>
    );
};

/** Shows a toast whose footer counts down to its dismissal. */
const countdownToast = (options: CountdownToastOptions) =>
    toast.custom((id) => <CountdownToastCard {...options} id={id} />, {
        classNames: { toast: "!border-0 !bg-transparent !p-0 !shadow-none" },
        duration: Infinity,
    });

export { countdownToast };
export type { CountdownToastAction, CountdownToastOptions, CountdownToastTone };
