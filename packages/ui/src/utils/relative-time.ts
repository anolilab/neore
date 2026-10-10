const DAY = 24 * 60 * 60 * 1000;

const UNITS: ReadonlyArray<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 365 * DAY],
    ["month", 30 * DAY],
    ["week", 7 * DAY],
    ["day", DAY],
    ["hour", 60 * 60 * 1000],
    ["minute", 60 * 1000],
];

/**
 * Words a time relative to now ("3 days ago", "vor 3 Tagen", "3 日前") in the
 * given locale — pass the active Lingui locale (`useLingui().i18n.locale`).
 * `Intl` instead of date-fns' `formatDistanceToNow`, which words everything in
 * English unless each of its locale modules is bundled.
 */
const formatTimeAgo = (date: Date | number, locale: string, now: number = Date.now()): string => {
    const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
    const elapsed = (typeof date === "number" ? date : date.getTime()) - now;

    for (const [unit, size] of UNITS) {
        if (Math.abs(elapsed) >= size) {
            return format.format(Math.round(elapsed / size), unit);
        }
    }

    return format.format(0, "second");
};

export default formatTimeAgo;
