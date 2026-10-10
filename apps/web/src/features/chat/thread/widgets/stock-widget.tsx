"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { ArrowDown, ArrowUp, BarChart3, Minus } from "lucide-react";
import type { FC } from "react";

export interface StockData {
    error?: string;
    historical?: {
        close: number;
        date: string;
    }[];
    news?: {
        publishedAt: string;
        source: string;
        title: string;
        url: string;
    }[];
    quote?: {
        change: number;
        changePercent: number;
        dividendYield?: number;
        high: number;
        low: number;
        marketCap?: number;
        name?: string;
        open: number;
        peRatio?: number;
        previousClose: number;
        price: number;
        symbol: string;
        volume: number;
        week52High?: number;
        week52Low?: number;
    };
    success: boolean;
}

const formatLargeNumber = (value: number, locale: string): string => {
    if (value >= 1_000_000_000_000) return `${(value / 1_000_000_000_000).toFixed(2)}T`;

    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;

    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;

    if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;

    return formatNumber(value, locale);
};

const formatPrice = (value: number, locale: string): string => formatNumber(value, locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** Mini sparkline SVG from historical data. */
const getTrendTextClass = (isNeutral: boolean, isPositive: boolean): string => {
    if (isNeutral) {
        return "text-gray-500";
    }

    return isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
};

const getTrendBadgeClass = (isNeutral: boolean, isPositive: boolean): string => {
    if (isNeutral) {
        return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400";
    }

    return isPositive ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
};

const Sparkline: FC<{ data: number[]; isPositive: boolean }> = ({ data, isPositive }) => {
    if (data.length < 2) {
        return null;
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const range = max - min || 1;
    const width = 80;
    const height = 24;

    const points = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - ((v - min) / range) * height}`).join(" ");

    return (
        <svg aria-hidden="true" className="shrink-0" height={height} viewBox={`0 0 ${width} ${height}`} width={width}>
            <polyline
                fill="none"
                points={points}
                stroke={isPositive ? "rgb(34, 197, 94)" : "rgb(239, 68, 68)"}
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={1.5}
            />
        </svg>
    );
};

Sparkline.displayName = "Sparkline";

interface StockWidgetProps {
    output: StockData;
}

const StockWidget: FC<StockWidgetProps> = ({ output }) => {
    const { i18n, t } = useLingui();

    if (!output.success || !output.quote) {
        return (
            <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-red-50 p-4 dark:bg-red-950/20">
                <p className="text-sm text-red-600 dark:text-red-400">{output.error ?? t`Failed to fetch stock data.`}</p>
            </div>
        );
    }

    const { historical, quote } = output;
    const isPositive = quote.change >= 0;
    const isNeutral = quote.change === 0;
    const sparklineData = historical?.map((h) => h.close) ?? [];

    return (
        <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border">
            {/* Header: Symbol + Price */}
            <div className="flex items-start justify-between p-4 pb-2">
                <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                        <h3 className="text-sm font-bold">{quote.symbol}</h3>
                        <span
                            className={cn(
                                "flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-semibold",
                                getTrendBadgeClass(isNeutral, isPositive),
                            )}
                        >
                            {isNeutral && <Minus aria-hidden="true" className="size-2.5" />}
                            {!isNeutral &&
                                (isPositive ? <ArrowUp aria-hidden="true" className="size-2.5" /> : <ArrowDown aria-hidden="true" className="size-2.5" />)}
                            {Math.abs(quote.changePercent).toFixed(2)}%
                        </span>
                    </div>
                    {quote.name && <p className="text-muted-foreground truncate text-xs">{quote.name}</p>}
                </div>
                <Sparkline data={sparklineData} isPositive={isPositive} />
            </div>

            {/* Price */}
            <div className="px-4 pb-3">
                <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold tabular-nums">${formatPrice(quote.price, i18n.locale)}</span>
                    <span className={cn("text-sm font-medium tabular-nums", getTrendTextClass(isNeutral, isPositive))}>
                        {isPositive ? "+" : ""}
                        {formatPrice(quote.change, i18n.locale)}
                    </span>
                </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t px-4 py-2.5 text-xs">
                <div className="flex justify-between">
                    <span className="text-muted-foreground">
                        <Trans context="stock opening price">Open</Trans>
                    </span>
                    <span className="font-medium tabular-nums">${formatPrice(quote.open, i18n.locale)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-muted-foreground">
                        <Trans>Prev Close</Trans>
                    </span>
                    <span className="font-medium tabular-nums">${formatPrice(quote.previousClose, i18n.locale)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-muted-foreground">
                        <Trans>High</Trans>
                    </span>
                    <span className="font-medium tabular-nums">${formatPrice(quote.high, i18n.locale)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-muted-foreground">
                        <Trans>Low</Trans>
                    </span>
                    <span className="font-medium tabular-nums">${formatPrice(quote.low, i18n.locale)}</span>
                </div>
                <div className="flex justify-between">
                    <span className="text-muted-foreground">
                        <Trans>Volume</Trans>
                    </span>
                    <span className="font-medium tabular-nums">{formatLargeNumber(quote.volume, i18n.locale)}</span>
                </div>
                {quote.marketCap != null && (
                    <div className="flex justify-between">
                        <span className="text-muted-foreground">
                            <Trans>Market Cap</Trans>
                        </span>
                        <span className="font-medium tabular-nums">${formatLargeNumber(quote.marketCap, i18n.locale)}</span>
                    </div>
                )}
            </div>

            {/* 52-week range */}
            {quote.week52High != null && quote.week52Low != null && (
                <div className="border-t px-4 py-2.5">
                    <div className="mb-1 flex items-center gap-1">
                        <BarChart3 aria-hidden="true" className="text-muted-foreground size-3" />
                        <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                            <Trans>52-week range</Trans>
                        </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                        <span className="tabular-nums">${formatPrice(quote.week52Low, i18n.locale)}</span>
                        <div className="relative h-1.5 flex-1 rounded-full bg-gray-200 dark:bg-gray-700">
                            <div
                                className="absolute top-0 left-0 h-full rounded-full bg-blue-500"
                                style={{
                                    width: `${Math.min(100, Math.max(0, ((quote.price - quote.week52Low) / (quote.week52High - quote.week52Low)) * 100))}%`,
                                }}
                            />
                        </div>
                        <span className="tabular-nums">${formatPrice(quote.week52High, i18n.locale)}</span>
                    </div>
                </div>
            )}
        </div>
    );
};

StockWidget.displayName = "StockWidget";

export default StockWidget;
