"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { ArrowDown, ArrowUp, Minus } from "lucide-react";
import type { FC } from "react";
import { memo } from "react";

export interface CryptoData {
    data?: {
        id: string;
        image?: { large?: string; small?: string; thumb?: string };
        lastUpdated?: string;
        marketData?: {
            circulatingSupply?: number;
            currentPrice?: Record<string, number>;
            high24h?: Record<string, number>;
            low24h?: Record<string, number>;
            marketCap?: Record<string, number>;
            maxSupply?: number;
            priceChangePercentage7d?: number;
            priceChangePercentage24h?: number;
            priceChangePercentage30d?: number;
            totalSupply?: number;
            totalVolume?: Record<string, number>;
        };
        name: string;
        symbol: string;
    };
    error?: string;
    success: boolean;
}

const formatLargeNumber = (value: number, locale: string): string => {
    if (value >= 1_000_000_000_000) return `$${(value / 1_000_000_000_000).toFixed(2)}T`;

    if (value >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;

    if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;

    return `$${formatNumber(value, locale)}`;
};

const formatPrice = (value: number, locale: string): string => {
    if (value >= 1000) return formatNumber(value, locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });

    if (value >= 1) return formatNumber(value, locale, { maximumFractionDigits: 4, minimumFractionDigits: 2 });

    return formatNumber(value, locale, { maximumFractionDigits: 6, minimumFractionDigits: 2 });
};

const getTrendTextClass = (isNeutral: boolean, isPositive: boolean): string => {
    if (isNeutral) {
        return "text-gray-500";
    }

    return isPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400";
};

const ChangeChip: FC<{ label: string; value?: number }> = ({ label, value }) => {
    if (value == null) {
        return null;
    }

    const isPositive = value >= 0;
    const isNeutral = value === 0;

    return (
        <div className="flex flex-col items-center gap-0.5">
            <span className="text-muted-foreground text-[10px]">{label}</span>
            <span className={cn("flex items-center gap-0.5 text-[11px] font-semibold tabular-nums", getTrendTextClass(isNeutral, isPositive))}>
                {isNeutral && <Minus aria-hidden="true" className="size-2.5" />}
                {!isNeutral && (isPositive ? <ArrowUp aria-hidden="true" className="size-2.5" /> : <ArrowDown aria-hidden="true" className="size-2.5" />)}
                {Math.abs(value).toFixed(2)}%
            </span>
        </div>
    );
};

interface CryptoWidgetProps {
    output: CryptoData;
}

const CryptoWidget: FC<CryptoWidgetProps> = memo(({ output }) => {
    const { i18n, t } = useLingui();

    if (!output.success || !output.data) {
        return (
            <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-red-50 p-4 dark:bg-red-950/20">
                <p className="text-sm text-red-600 dark:text-red-400">{output.error ?? t`Failed to fetch cryptocurrency data.`}</p>
            </div>
        );
    }

    const { data } = output;
    const md = data.marketData;
    const price = md?.currentPrice?.usd;
    const change24h = md?.priceChangePercentage24h;
    const isPositive = (change24h ?? 0) >= 0;

    return (
        <div
            className={cn(
                "my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-gradient-to-br",
                isPositive
                    ? "from-green-50/50 to-emerald-50/50 dark:from-green-950/10 dark:to-emerald-950/10"
                    : "from-red-50/50 to-orange-50/50 dark:from-red-950/10 dark:to-orange-950/10",
            )}
        >
            {/* Header: Coin info + price */}
            <div className="flex items-start justify-between p-4 pb-2">
                <div className="flex items-center gap-2.5">
                    {data.image?.small && (
                        <img
                            alt=""
                            className="size-8 shrink-0 rounded-full"
                            onError={(e) => {
                                (e.target as HTMLImageElement).style.display = "none";
                            }}
                            src={data.image.small}
                        />
                    )}
                    <div className="min-w-0">
                        <h3 className="text-sm font-bold">{data.name}</h3>
                        <p className="text-muted-foreground text-xs uppercase">{data.symbol}</p>
                    </div>
                </div>
                {change24h != null && (
                    <span
                        className={cn(
                            "flex items-center gap-0.5 rounded-full px-2 py-0.5 text-xs font-semibold",
                            isPositive
                                ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300"
                                : "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
                        )}
                    >
                        {isPositive ? <ArrowUp aria-hidden="true" className="size-3" /> : <ArrowDown aria-hidden="true" className="size-3" />}
                        {Math.abs(change24h).toFixed(2)}%
                    </span>
                )}
            </div>

            {/* Price */}
            {price != null && (
                <div className="px-4 pb-3">
                    <span className="text-2xl font-bold tabular-nums">${formatPrice(price, i18n.locale)}</span>
                </div>
            )}

            {/* Change periods */}
            {md && (md.priceChangePercentage24h != null || md.priceChangePercentage7d != null || md.priceChangePercentage30d != null) && (
                <div className="flex justify-around border-t px-4 py-2.5">
                    <ChangeChip label={t`24h`} value={md.priceChangePercentage24h} />
                    <ChangeChip label={t`7d`} value={md.priceChangePercentage7d} />
                    <ChangeChip label={t`30d`} value={md.priceChangePercentage30d} />
                </div>
            )}

            {/* Market stats */}
            {md && (
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 border-t px-4 py-2.5 text-xs">
                    {md.marketCap?.usd != null && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">
                                <Trans>Market Cap</Trans>
                            </span>
                            <span className="font-medium tabular-nums">{formatLargeNumber(md.marketCap.usd, i18n.locale)}</span>
                        </div>
                    )}
                    {md.totalVolume?.usd != null && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">
                                <Trans>Volume (24h)</Trans>
                            </span>
                            <span className="font-medium tabular-nums">{formatLargeNumber(md.totalVolume.usd, i18n.locale)}</span>
                        </div>
                    )}
                    {md.high24h?.usd != null && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">
                                <Trans>24h High</Trans>
                            </span>
                            <span className="font-medium tabular-nums">${formatPrice(md.high24h.usd, i18n.locale)}</span>
                        </div>
                    )}
                    {md.low24h?.usd != null && (
                        <div className="flex justify-between">
                            <span className="text-muted-foreground">
                                <Trans>24h Low</Trans>
                            </span>
                            <span className="font-medium tabular-nums">${formatPrice(md.low24h.usd, i18n.locale)}</span>
                        </div>
                    )}
                    {md.circulatingSupply != null && (
                        <div className="col-span-2 flex justify-between">
                            <span className="text-muted-foreground">
                                <Trans>Circulating Supply</Trans>
                            </span>
                            <span className="font-medium tabular-nums">
                                {formatNumber(md.circulatingSupply, i18n.locale, { maximumFractionDigits: 0 })} {data.symbol.toUpperCase()}
                            </span>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
});

CryptoWidget.displayName = "CryptoWidget";

export default CryptoWidget;
