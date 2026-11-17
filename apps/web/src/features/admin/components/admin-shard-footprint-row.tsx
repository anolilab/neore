"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { useState } from "react";

import { useShardFootprint } from "../hooks/use-admin";

interface FootprintTotals {
    /** Shards given up for this census: their counts are not in the totals. Each is reported once, so pages add up. */
    abandonedShards: number;
    approxBytes: number;
    messageRows: number;
    shards: number;
    threads: number;
}

const NO_TOTALS: FootprintTotals = { abandonedShards: 0, approxBytes: 0, messageRows: 0, shards: 0, threads: 0 };

const sumTotals = (pages: FootprintTotals[]): FootprintTotals => {
    const sum = { ...NO_TOTALS };

    for (const page of pages) {
        sum.abandonedShards += page.abandonedShards;
        sum.approxBytes += page.approxBytes;
        sum.messageRows += page.messageRows;
        sum.shards += page.shards;
        sum.threads += page.threads;
    }

    return sum;
};

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

/**
 * Totals of the user shards' stored conversation data. Shows the shards measured so far; each
 * "Measure more shards" press measures the next page of the census and adds it to the totals.
 * Totals only: no thread ids are shown.
 */
const AdminShardFootprintRow = () => {
    const { i18n, t } = useLingui();
    // Pages measured before the current one. The current page is `page.data`.
    const [measured, setMeasured] = useState<FootprintTotals[]>([]);
    const [cursor, setCursor] = useState<string | undefined>(undefined);
    const page = useShardFootprint(cursor);
    const totals = sumTotals(page.data ? [...measured, page.data] : measured);
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

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t`Shard footprint`}</CardTitle>
                <CardDescription>
                    {t`Stored conversation data across user shards: threads, message rows and an estimate of their size. Counts only; no thread is listed.`}
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
                        <Button disabled={page.isFetching} onClick={retryPage} type="button" variant="outline">
                            {t`Try again`}
                        </Button>
                    ) : null}
                    {finished && totals.abandonedShards === 0 ? <p className="text-muted-foreground text-sm">{t`All shards measured.`}</p> : null}
                </div>
            </CardContent>
        </Card>
    );
};

export default AdminShardFootprintRow;
