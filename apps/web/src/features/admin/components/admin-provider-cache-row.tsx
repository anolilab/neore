"use client";

import { useLingui } from "@lingui/react/macro";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@neore/ui/components/card";
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from "@neore/ui/components/table";
import { ToggleGroup, ToggleGroupItem } from "@neore/ui/components/toggle-group";
import { formatDate, formatDateTime, formatNumber } from "@neore/ui/utils/locale-format";
import { useState } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";

import { useProviderCacheReadings } from "../hooks/use-admin";
import type { CacheCounts } from "../lib/provider-cache";
import { byDay, cachedShare, resolveTimeZone, sumCounts } from "../lib/provider-cache";

type WindowDays = 1 | 7 | 30;

const WINDOWS: WindowDays[] = [1, 7, 30];

const WINDOW_VALUES: ReadonlySet<string> = new Set(["1", "7", "30"]);

const isWindow = (value: string | undefined): value is `${WindowDays}` => value !== undefined && WINDOW_VALUES.has(value);

/** Shown for a figure before any readings arrived, so a failed or pending load never reads as zero traffic. */
const NO_READING = "—";

const shareText = (counts: CacheCounts | undefined, locale: string): string => {
    const share = counts === undefined ? null : cachedShare(counts);

    return share === null ? "—" : formatNumber(share, locale, { maximumFractionDigits: 1, style: "percent" });
};

/**
 * How much of the prompt sent to providers they served from their own prompt cache: per day and for the window across
 * the provider/model pairs that cached in the last 30 days, an hour-by-hour table, and the top models' shares. A drop
 * after a deploy is what a prompt change cost in cache reads.
 */
const AdminProviderCacheRow = () => {
    const { i18n, t } = useLingui();
    const [days, setDays] = useState<WindowDays>(7);
    const readings = useProviderCacheReadings(days);
    const userSettings = useUserSettings();
    const { locale } = i18n;
    const timeZone = resolveTimeZone(userSettings.data?.timezone);
    // `undefined` until a response arrived (or after a failed first one); `[]` is a loaded window with no traffic.
    const { data } = readings;
    const hours = data?.hours ?? [];
    const models = data?.models ?? [];
    const total = data === undefined ? undefined : sumCounts(hours);
    const dailyRows = byDay(hours, timeZone);
    const countText = (value: number | undefined): string => (value === undefined ? NO_READING : formatNumber(value, locale));

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t`Provider prompt cache`}</CardTitle>
                <CardDescription>
                    {t`The share of prompt tokens providers served from their own cache. Days and hours count the provider and model pairs that cached in the last 30 days; the model table lists the top 50 models by prompt tokens. Answers from the gateway's response cache are left out. Days and hours are in ${timeZone}.`}
                </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
                <ToggleGroup
                    aria-label={t`Window`}
                    onValueChange={(value: ReadonlyArray<string> | undefined) => {
                        const next = value?.[0];

                        if (isWindow(next)) {
                            setDays(Number(next) as WindowDays);
                        }
                    }}
                    value={[String(days)]}
                    variant="outline"
                >
                    {WINDOWS.map((window) => (
                        <ToggleGroupItem key={window} value={String(window)}>
                            {window === 1 ? t`24 hours` : t`${formatNumber(window, locale)} days`}
                        </ToggleGroupItem>
                    ))}
                </ToggleGroup>
                <p aria-live="polite" className="text-muted-foreground text-sm" role="status">
                    {readings.isFetching ? t`Loading…` : null}
                </p>
                {readings.isError ? (
                    <p className="text-destructive text-sm" role="alert">
                        {t`The provider cache readings could not be loaded.`}
                    </p>
                ) : null}
                <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
                    <div>
                        <dt className="text-muted-foreground text-sm">{t`Served from cache`}</dt>
                        <dd className="text-2xl font-semibold">{shareText(total, locale)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-sm">{t`Prompt tokens`}</dt>
                        <dd className="text-2xl font-semibold">{countText(total?.promptTokens)}</dd>
                    </div>
                    <div>
                        <dt className="text-muted-foreground text-sm">{t`Requests`}</dt>
                        <dd className="text-2xl font-semibold">{countText(total?.requests)}</dd>
                    </div>
                </dl>
                {data === undefined ? null : (
                    <p className="text-muted-foreground text-sm">
                        {t`All provider traffic in the window, caching or not. Requests: ${formatNumber(data.all.requests, locale)}. Prompt tokens: ${formatNumber(data.all.promptTokens, locale)}. Served from cache: ${shareText(data.all, locale)}.`}
                    </p>
                )}
                <Table>
                    <TableCaption>{t`By day, newest first.`}</TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t`Day`}</TableHead>
                            <TableHead className="text-right">{t`Requests`}</TableHead>
                            <TableHead className="text-right">{t`Prompt tokens`}</TableHead>
                            <TableHead className="text-right">{t`Served from cache`}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {dailyRows.map((row) => (
                            <TableRow key={row.day}>
                                {/* `row.day` is already the date in `timeZone`; read at UTC midnight it prints as that same date. */}
                                <TableHead scope="row">{formatDate(`${row.day}T00:00:00.000Z`, locale, { timeZone: "UTC" })}</TableHead>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.requests, locale)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.promptTokens, locale)}</TableCell>
                                <TableCell className="text-right tabular-nums">{shareText(row, locale)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
                <details>
                    <summary className="cursor-pointer text-sm font-medium">{t`By hour`}</summary>
                    <Table>
                        <TableCaption>{t`By hour, oldest first. A drop that starts at one hour across models points at a change in what is sent.`}</TableCaption>
                        <TableHeader>
                            <TableRow>
                                <TableHead>{t`Hour`}</TableHead>
                                <TableHead className="text-right">{t`Requests`}</TableHead>
                                <TableHead className="text-right">{t`Prompt tokens`}</TableHead>
                                <TableHead className="text-right">{t`Served from cache`}</TableHead>
                            </TableRow>
                        </TableHeader>
                        <TableBody>
                            {hours.map((row) => (
                                <TableRow key={row.hour}>
                                    <TableHead scope="row">{formatDateTime(row.hour, locale, { dateStyle: "short", timeStyle: "short", timeZone })}</TableHead>
                                    <TableCell className="text-right tabular-nums">{formatNumber(row.requests, locale)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{formatNumber(row.promptTokens, locale)}</TableCell>
                                    <TableCell className="text-right tabular-nums">{shareText(row, locale)}</TableCell>
                                </TableRow>
                            ))}
                        </TableBody>
                    </Table>
                </details>
                <Table>
                    <TableCaption>
                        {data !== undefined && data.pairs > models.length
                            ? t`By model, most prompt tokens first: the top ${formatNumber(models.length, locale)} of ${formatNumber(data.pairs, locale)} provider and model pairs.`
                            : t`By model, most prompt tokens first.`}
                    </TableCaption>
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t`Model`}</TableHead>
                            <TableHead>{t`Provider`}</TableHead>
                            <TableHead className="text-right">{t`Requests`}</TableHead>
                            <TableHead className="text-right">{t`Prompt tokens`}</TableHead>
                            <TableHead className="text-right">{t`Served from cache`}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {models.map((row) => (
                            <TableRow key={`${row.provider}:${row.modelId}`}>
                                <TableHead scope="row">{row.modelId}</TableHead>
                                <TableCell>{row.provider}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.requests, locale)}</TableCell>
                                <TableCell className="text-right tabular-nums">{formatNumber(row.promptTokens, locale)}</TableCell>
                                <TableCell className="text-right tabular-nums">{shareText(row, locale)}</TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </CardContent>
        </Card>
    );
};

export default AdminProviderCacheRow;
