const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["day", 24 * 60 * 60 * 1000],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
];

/** Words a timestamp relative to now ("5 minutes ago", "vor 5 Minuten") through `Intl`, in the UI locale. */
export const formatRelativeTime = (timestamp: number, locale: string, now = Date.now()): string => {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const elapsed = timestamp - now;

    for (const [unit, size] of UNITS) {
        if (Math.abs(elapsed) >= size) {
            return format.format(Math.round(elapsed / size), unit);
        }
    }

    return format.format(0, "minute");
};
