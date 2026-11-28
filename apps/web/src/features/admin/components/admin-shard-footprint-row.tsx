"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { SHARD_FOOTPRINT_QUERY_KEY, useShardFootprint } from "../hooks/use-admin";
import type { FootprintTotals } from "../lib/shard-footprint";
import { COMPACT_AFTER_DAYS, readingsOf, sumTotals } from "../lib/shard-footprint";
import { AdminBlock, AdminSection } from "./admin-section";

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
        <AdminSection
            description={t`Stored conversation data across user shards: threads, message rows and an estimate of their size, by thread group and age. Counts only; no thread or shard is listed.`}
            title={t`Shard footprint`}
        >
            {page.isError ? (
                <AdminBlock>
                    <p className="text-destructive text-sm" role="alert">
                        {t`The shard footprint could not be measured.`}
                    </p>
                </AdminBlock>
            ) : null}
            <AdminBlock>
                <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
                    <div>
                        <dt className="text-muted-foreground font-mono text-xs">{t`Shards`}</dt>
                        <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(totals.shards, i18n.locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground font-mono text-xs">{t`Threads`}</dt>
                        <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(totals.threads, i18n.locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground font-mono text-xs">{t`Message rows`}</dt>
                        <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatNumber(totals.messageRows, i18n.locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground font-mono text-xs">{t`Approximate size`}</dt>
                        <dd className="mt-1 text-2xl font-semibold tabular-nums">{formatBytes(totals.approxBytes, i18n.locale)}</dd>
                    </div>
                </dl>
            </AdminBlock>
            <AdminBlock className="px-2">
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
            </AdminBlock>
            <AdminBlock className="px-2">
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
            </AdminBlock>
            <AdminBlock>
                <dl className="grid grid-cols-1 gap-x-8 gap-y-4 text-sm md:grid-cols-2">
                    <div>
                        <dt className="text-muted-foreground text-xs">{t`Tool output's share of the stored size`}</dt>
                        <dd className="font-medium">{formatShare(readings.kept.toolBytes + readings.other.toolBytes, totals.approxBytes, locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-xs">{t`Tool results of 64 KB or more, in threads idle at least ${formatNumber(COMPACT_AFTER_DAYS, locale)} days`}</dt>
                        <dd className="font-medium">
                            {t`${plural(readings.compactable.largeToolRows, { one: "# result", other: "# results" })}, ${formatBytes(readings.compactable.largeToolBytes, locale)}`}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-xs">{t`Pinned threads`}</dt>
                        <dd className="font-medium">
                            {t`${plural(readings.pinned.threads, { one: "# thread", other: "# threads" })}, ${formatBytes(readings.pinned.approxBytes, locale)}`}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-xs">{t`Trashed, temporary, being deleted or orphaned`}</dt>
                        <dd className="font-medium">
                            {t`${plural(readings.other.threads, { one: "# thread", other: "# threads" })}, ${formatBytes(readings.other.approxBytes, locale)}`}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-xs">{t`Message rows of the largest threads`}</dt>
                        <dd className="font-medium tabular-nums">
                            {totals.largestThreadRows.length === 0 ? "—" : totals.largestThreadRows.map((rows) => formatNumber(rows, locale)).join(", ")}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-xs">{t`Sizes of the largest shards`}</dt>
                        <dd className="font-medium tabular-nums">
                            {totals.largestShardBytes.length === 0 ? "—" : totals.largestShardBytes.map((bytes) => formatBytes(bytes, locale)).join(", ")}
                        </dd>
                    </div>
                </dl>
            </AdminBlock>
            {page.data !== undefined && page.data.pendingShards > 0 ? (
                <AdminBlock>
                    <p className="text-muted-foreground text-sm">
                        {t`Shards still being measured: ${formatNumber(page.data.pendingShards, i18n.locale)}. Measure more shards to finish them.`}
                    </p>
                </AdminBlock>
            ) : null}
            {totals.abandonedShards > 0 ? (
                <AdminBlock>
                    <p className="text-muted-foreground text-sm">{t`Shards that could not be measured are left out of the totals: ${formatNumber(totals.abandonedShards, i18n.locale)}.`}</p>
                </AdminBlock>
            ) : null}
            <AdminBlock className="flex flex-wrap items-center gap-3">
                {/* Always mounted, so screen readers announce the change when measuring starts and ends. */}
                <p aria-live="polite" className="text-muted-foreground text-sm empty:-me-3" role="status">
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
            </AdminBlock>
        </AdminSection>
    );
};

export default AdminShardFootprintRow;
