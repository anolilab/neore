"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { SHARD_FOOTPRINT_QUERY_KEY, useShardFootprint } from "../hooks/use-admin";
import type { FootprintTotals } from "../lib/shard-footprint";
import { COMPACT_AFTER_DAYS, readingsOf, sumTotals } from "../lib/shard-footprint";

const formatBytes = (bytes: number, locale: string): string => {
    const units = ["B", "KB", "MB", "GB", "TB"];
    let value = bytes;
    let unit = 0;

    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }

    return `${formatNumber(value, locale, { maximumFractionDigits: 1 })} ${units[unit]}`;
};

const formatShare = (part: number, whole: number, locale: string): string =>
    whole === 0 ? "—" : formatNumber(part / whole, locale, { maximumFractionDigits: 1, style: "percent" });

/**
 * What a failed page offers: "Try again" re-measures it, and, once past the first page, "Start over" measures from the
 * first page (a cursor from before a deploy is one the backend no longer takes, so retrying it fails again).
 */
const FailedPageActions = ({
    busy,
    canStartOver,
    onRetry,
    onStartOver,
}: {
    busy: boolean;
    canStartOver: boolean;
    onRetry: () => void;
    onStartOver: () => void;
}) => {
    const { t } = useLingui();

    return (
        <>
            <Button disabled={busy} onClick={onRetry} type="button" variant="outline">
                {t`Try again`}
            </Button>
            {canStartOver ? (
                <Button disabled={busy} onClick={onStartOver} type="button" variant="ghost">
                    {t`Start over`}
                </Button>
            ) : null}
        </>
    );
};

/**
 * Totals of the user shards' stored conversation data. Shows the shards measured so far; each
 * "Measure more shards" press measures the next page of the census and adds it to the totals.
 * Totals only: no thread ids are shown. Below the totals, the readings the retention decisions need: archived threads by
 * how long they have been archived, active threads by how long they have been idle, and tool output's share.
 */
const AdminShardFootprintRow = () => {
    const { i18n, t } = useLingui();
    const queryClient = useQueryClient();
    // Pages measured before the current one. The current page is `page.data`.
    const [measured, setMeasured] = useState<FootprintTotals[]>([]);
    const [cursor, setCursor] = useState<string | undefined>(undefined);
    const page = useShardFootprint(cursor);
    const totals = sumTotals(page.data ? [...measured, page.data] : measured);
    const readings = readingsOf(totals.breakdown);
    const { locale } = i18n;
    const finished = page.data !== undefined && page.data.isDone;

    const measureNext = () => {
        const current = page.data;

        if (!current || current.continueCursor === null) {
            return;
        }

        setMeasured((previous) => [...previous, current]);
        setCursor(current.continueCursor);
    };

    // Re-measures the page that failed; the measured pages before it are kept.
    const retryPage = () => {
        page.refetch();
    };

    // Drops the measured pages, the cursor and every cached page of this census, so the first page is measured afresh
    // and no page of the old census is shown or continued from.
    const startOver = () => {
        queryClient.removeQueries({ queryKey: SHARD_FOOTPRINT_QUERY_KEY });
        setMeasured([]);
        setCursor(undefined);
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t`Shard footprint`}</CardTitle>
                <CardDescription>
                    {t`Stored conversation data across user shards: threads, message rows and an estimate of their size, by thread group and age. Counts only; no thread or shard is listed.`}
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                {page.isError ? (
                    <p className="text-destructive text-sm" role="alert">
                        {t`The shard footprint could not be measured.`}
                    </p>
                ) : null}
                <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    <div>
                        <dt className="text-muted-foreground text-sm">{t`Shards`}</dt>
                        <dd className="text-2xl font-semibold">{formatNumber(totals.shards, i18n.locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-sm">{t`Threads`}</dt>
                        <dd className="text-2xl font-semibold">{formatNumber(totals.threads, i18n.locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-sm">{t`Message rows`}</dt>
                        <dd className="text-2xl font-semibold">{formatNumber(totals.messageRows, i18n.locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-sm">{t`Approximate size`}</dt>
                        <dd className="text-2xl font-semibold">{formatBytes(totals.approxBytes, i18n.locale)}</dd>
                    </div>
                </dl>
                <Table>
                    <TableCaption>{t`Archived threads, by how long ago they were archived. Pinned threads are counted apart: they are never deleted.`}</TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t`Archived for at least`}</TableHead>
                            <TableHead className="text-right">{t`Threads`}</TableHead>
                            <TableHead className="text-right">{t`Message rows`}</TableHead>
                            <TableHead className="text-right">{t`Approximate size`}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {readings.archived.map((row) => (
                            <TableRow key={row.sinceDays}>
                                <TableHead scope="row">{row.sinceDays === 0 ? t`Any time` : t`${formatNumber(row.sinceDays, locale)} days`}</TableHead>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.threads, locale)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.messageRows, locale)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatBytes(row.approxBytes, locale)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                <Table>
                    <TableCaption>{t`Active threads, by days since their last activity. Threads waiting on a person are included.`}</TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t`Idle for at least`}</TableHead>
                            <TableHead className="text-right">{t`Threads`}</TableHead>
                            <TableHead className="text-right">{t`Approximate size`}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {readings.idle.map((row) => (
                            <TableRow key={row.sinceDays}>
                                <TableHead scope="row">{t`${formatNumber(row.sinceDays, locale)} days`}</TableHead>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.threads, locale)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatBytes(row.approxBytes, locale)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                <dl className="grid grid-cols-1 gap-4 text-sm md:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground">{t`Tool output's share of the stored size`}</dt>
                        <dd className="font-semibold">{formatShare(readings.kept.toolBytes + readings.other.toolBytes, totals.approxBytes, locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">{t`Tool results of 64 KB or more, in threads idle at least ${formatNumber(COMPACT_AFTER_DAYS, locale)} days`}</dt>
                        <dd className="font-semibold">
                            {t`${plural(readings.compactable.largeToolRows, { one: "# result", other: "# results" })}, ${formatBytes(readings.compactable.largeToolBytes, locale)}`}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">{t`Pinned threads`}</dt>
                        <dd className="font-semibold">
                            {t`${plural(readings.pinned.threads, { one: "# thread", other: "# threads" })}, ${formatBytes(readings.pinned.approxBytes, locale)}`}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">{t`Trashed, temporary, being deleted or orphaned`}</dt>
                        <dd className="font-semibold">
                            {t`${plural(readings.other.threads, { one: "# thread", other: "# threads" })}, ${formatBytes(readings.other.approxBytes, locale)}`}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">{t`Message rows of the largest threads`}</dt>
                        <dd className="font-semibold tabular-nums">
                            {totals.largestThreadRows.length === 0 ? "—" : totals.largestThreadRows.map((rows) => formatNumber(rows, locale)).join(", ")}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground">{t`Sizes of the largest shards`}</dt>
                        <dd className="font-semibold tabular-nums">
                            {totals.largestShardBytes.length === 0 ? "—" : totals.largestShardBytes.map((bytes) => formatBytes(bytes, locale)).join(", ")}
                        </dd>
                    </div>
                </dl>
                {page.data !== undefined && page.data.pendingShards > 0 ? (
                    <p className="text-muted-foreground text-sm">
                        {t`Shards still being measured: ${formatNumber(page.data.pendingShards, i18n.locale)}. Measure more shards to finish them.`}
                    </p>
                ) : null}
                {totals.abandonedShards > 0 ? (
                    <p className="text-muted-foreground text-sm">{t`Shards that could not be measured are left out of the totals: ${formatNumber(totals.abandonedShards, i18n.locale)}.`}</p>
                ) : null}
                <div className="flex flex-wrap items-center gap-3">
                    {/* Always mounted, so screen readers announce the change when measuring starts and ends. */}
                    <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
                        {page.isFetching ? t`Measuring…` : null}
                    </p>
                    {!finished && page.data !== undefined ? (
                        <Button disabled={page.isFetching} onClick={measureNext} type="button">
                            {t`Measure more shards`}
                        </Button>
                    ) : null}
                    {page.isError ? (
                        <FailedPageActions busy={page.isFetching} canStartOver={cursor !== undefined} onRetry={retryPage} onStartOver={startOver} />
                    ) : null}
                    {finished && totals.abandonedShards === 0 ? <p className="text-muted-foreground text-sm">{t`All shards measured.`}</p> : null}
                </div>
            </CardContent>
        </Card>
    );
};

export default AdminShardFootprintRow;
