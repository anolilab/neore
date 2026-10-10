import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Skeleton } from "@neore/ui/components/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import cn from "@neore/ui/utils/cn";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays } from "lucide-react";
import type { FC, KeyboardEvent } from "react";
import { useId, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import { BACKFILL_REFETCH_MS, useRefetchAfterBackfill } from "../../hooks/use-usage-backfill";
import type { HeatmapCell, HeatmapLevel, HeatmapMetric } from "../../lib/usage-activity";
import { addDays, buildHeatmap, dayKeyToDate, daysBetween, formatUsd, HEATMAP_WEEKS, localDayKey, stepDay } from "../../lib/usage-activity";

/**
 * Cell colours from the shared chart ramp. Every active level keeps at least
 * 3:1 against the card in its theme (light: chart-3/4/5 on white = 3.2/4.9/7.1;
 * dark: chart-4/3/1 on charcoal = 3.3/5.0/11.5), so "had activity" reads
 * without colour discrimination. Exact values are in each day's label and the
 * monthly table below.
 */
const LEVEL_CLASSES: Record<HeatmapLevel, string> = {
    0: "bg-muted",
    1: "bg-chart-3 dark:bg-chart-4",
    2: "bg-chart-4 dark:bg-chart-3",
    3: "bg-chart-5 dark:bg-chart-1",
};

const LEVELS: HeatmapLevel[] = [0, 1, 2, 3];

/** Weekday rows that carry a label (Mon, Wed, Fri), as offsets from the first drawn Monday. */
const LABELLED_WEEKDAYS = [0, 2, 4];

const CELL_TRACK = "0.75rem";

const findCell = (weeks: HeatmapCell[][], date: string | null): HeatmapCell | undefined => {
    if (date === null) {
        return undefined;
    }

    for (const week of weeks) {
        const cell = week.find((candidate) => candidate.date === date);

        if (cell) {
            return cell;
        }
    }

    return undefined;
};

interface UsageActivityHeatmapProps {
    /** Earlier replies are still being added to the rollup (`useUsageBackfill`). */
    backfilling: boolean;
}

const UsageActivityHeatmap: FC<UsageActivityHeatmapProps> = ({ backfilling }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const titleId = useId();
    const summaryId = useId();
    const [today] = useState(() => localDayKey(new Date()));
    const [metric, setMetric] = useState<HeatmapMetric>("replies");
    const [activeDate, setActiveDate] = useState<string | null>(null);

    // One-shot: a year of aggregates would otherwise re-run on every reply. While
    // the backfill adds earlier replies it is re-read now and then instead.
    const { data, isError, isPending, refetch } = useQuery({
        ...crpc.usage.activity.getActivityHeatmap.queryOptions({ toDate: today }, { live: false }),
        refetchInterval: backfilling ? BACKFILL_REFETCH_MS : false,
    });

    useRefetchAfterBackfill(backfilling, refetch);

    const model = buildHeatmap(data?.days ?? [], today, metric);
    const locale = i18n.locale || "en";
    const dayFormat = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
    const monthFormat = new Intl.DateTimeFormat(locale, { month: "short", timeZone: "UTC" });
    const monthYearFormat = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC", year: "numeric" });
    const weekdayFormat = new Intl.DateTimeFormat(locale, { timeZone: "UTC", weekday: "short" });

    const describeCell = (cell: HeatmapCell): string => {
        const date = dayFormat.format(dayKeyToDate(cell.date));

        if (cell.replies === 0) {
            return t`${date}: no replies`;
        }

        // Inside `t`: a bare `plural()` compiles to the global i18n, which this app never activates.
        const replies = t`${plural(cell.replies, { one: "# reply", other: "# replies" })}`;
        const cost = formatUsd(cell.costMicrodollars, locale);

        return t`${date}: ${replies}, ${cost}`;
    };

    const activeCell = findCell(model.weeks, activeDate);
    // Before the first key press the slider sits on today.
    const focusedCell = activeCell ??
        findCell(model.weeks, model.toDate) ?? { costMicrodollars: 0, date: model.toDate, inRange: true, level: 0, replies: 0, tokens: 0 };
    const totalReplies = t`${plural(model.totalReplies, { one: "# reply", other: "# replies" })}`;
    const activeDays = t`${plural(model.activeDays, { one: "# active day", other: "# active days" })}`;
    const totalCost = formatUsd(model.totalCostMicrodollars, locale);
    const summary = t`${totalReplies} on ${activeDays} in the last year, ${totalCost} spent.`;

    const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const next = stepDay(activeDate ?? model.toDate, event.key, model);

        if (next === undefined) {
            return;
        }

        event.preventDefault();
        setActiveDate(next);
    };

    return (
        <Card>
            <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <CardTitle className="flex items-center gap-2 text-base" id={titleId}>
                            <CalendarDays aria-hidden="true" className="size-4" />
                            {t`Activity`}
                        </CardTitle>
                        <CardDescription>{t`Replies and spend per day over the last 53 weeks`}</CardDescription>
                    </div>
                    <ToggleGroup
                        aria-label={t`Colour days by`}
                        className="gap-1"
                        onValueChange={(value) => {
                            const next = value?.[0];

                            if (next === "cost" || next === "replies") {
                                setMetric(next);
                            }
                        }}
                        size="sm"
                        value={[metric]}
                        variant="outline"
                    >
                        <ToggleGroupItem value="replies">{t`Replies`}</ToggleGroupItem>
                        <ToggleGroupItem value="cost">{t`Spend`}</ToggleGroupItem>
                    </ToggleGroup>
                </div>
            </CardHeader>
            <CardContent className="space-y-3">
                {isPending && <Skeleton className="h-28 w-full" />}
                {isError && <p className="text-destructive text-sm">{t`Could not load your activity.`}</p>}
                {!isPending && !isError && (
                    <>
                        <p className="text-sm" id={summaryId}>
                            {summary}
                        </p>

                        {/*
                         * A day picker over the year: arrow keys step a day (up/down) or a week (left/right),
                         * and the slider's value text reads the day out. It is also the focus stop that lets
                         * keyboard users scroll the chart sideways on narrow screens. The monthly table below
                         * is the browsable view of the same data.
                         */}
                        <div
                            aria-describedby={summaryId}
                            aria-labelledby={titleId}
                            aria-orientation="horizontal"
                            aria-valuemax={daysBetween(model.fromDate, model.toDate)}
                            aria-valuemin={0}
                            aria-valuenow={daysBetween(model.fromDate, focusedCell.date)}
                            aria-valuetext={describeCell(focusedCell)}
                            className="focus-visible:ring-ring overflow-x-auto rounded-md pb-1 outline-none focus-visible:ring-2"
                            onBlur={() => setActiveDate(null)}
                            onKeyDown={handleKeyDown}
                            onPointerLeave={() => setActiveDate(null)}
                            onPointerOver={(event) => {
                                const { date } = (event.target as HTMLElement).dataset;

                                if (date) {
                                    setActiveDate(date);
                                }
                            }}
                            role="slider"
                            tabIndex={0}
                        >
                            <div
                                aria-hidden="true"
                                className="text-muted-foreground inline-grid gap-[3px] text-[10px] leading-none"
                                style={{
                                    gridTemplateColumns: `auto repeat(${String(HEATMAP_WEEKS)}, ${CELL_TRACK})`,
                                    gridTemplateRows: `auto repeat(7, ${CELL_TRACK})`,
                                }}
                            >
                                {model.monthStarts.map((start) => (
                                    <span className="whitespace-nowrap" key={start.month} style={{ gridColumnStart: start.weekIndex + 2, gridRowStart: 1 }}>
                                        {monthFormat.format(dayKeyToDate(`${start.month}-01`))}
                                    </span>
                                ))}
                                {LABELLED_WEEKDAYS.map((weekday) => (
                                    <span className="self-center pr-1" key={weekday} style={{ gridColumnStart: 1, gridRowStart: weekday + 2 }}>
                                        {weekdayFormat.format(dayKeyToDate(addDays(model.fromDate, weekday)))}
                                    </span>
                                ))}
                                {model.weeks.map((week, weekIndex) =>
                                    week.map((cell, weekday) => (
                                        <span
                                            className={cn(
                                                "ring-foreground/10 rounded-[2px] ring-1 ring-inset",
                                                cell.inRange ? LEVEL_CLASSES[cell.level] : "invisible",
                                                cell.date === activeDate && "ring-foreground ring-2 ring-offset-0",
                                            )}
                                            data-date={cell.inRange ? cell.date : undefined}
                                            key={cell.date}
                                            style={{ gridColumnStart: weekIndex + 2, gridRowStart: weekday + 2 }}
                                            title={cell.inRange ? describeCell(cell) : undefined}
                                        />
                                    )),
                                )}
                            </div>
                        </div>

                        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                            {/* The hovered or focused day; the slider's value text is what a screen reader hears. */}
                            <p aria-hidden="true" className="text-muted-foreground min-h-4">
                                {activeCell ? describeCell(activeCell) : t`Hover a day, or focus the chart and use the arrow keys.`}
                            </p>
                            <div aria-hidden="true" className="text-muted-foreground flex items-center gap-1">
                                <span>{t`Less`}</span>
                                {LEVELS.map((level) => (
                                    <span className={cn("ring-foreground/10 size-3 rounded-[2px] ring-1 ring-inset", LEVEL_CLASSES[level])} key={level} />
                                ))}
                                <span>{t`More`}</span>
                            </div>
                        </div>

                        <p aria-live="polite" className="text-muted-foreground min-h-4 text-xs" role="status">
                            {backfilling ? t`Adding your earlier replies…` : null}
                        </p>

                        <table className="sr-only">
                            <caption>{t`Activity per month`}</caption>
                            <thead>
                                <tr>
                                    <th scope="col">{t`Month`}</th>
                                    <th scope="col">{t`Active days`}</th>
                                    <th scope="col">{t`Replies`}</th>
                                    <th scope="col">{t`Spend`}</th>
                                </tr>
                            </thead>
                            <tbody>
                                {model.months.map((month) => (
                                    <tr key={month.month}>
                                        <th scope="row">{monthYearFormat.format(dayKeyToDate(`${month.month}-01`))}</th>
                                        <td>{month.activeDays}</td>
                                        <td>{month.replies}</td>
                                        <td>{formatUsd(month.costMicrodollars, locale)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </>
                )}
            </CardContent>
        </Card>
    );
};

export default UsageActivityHeatmap;
