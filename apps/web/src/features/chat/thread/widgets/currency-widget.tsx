"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { formatNumber } from "@neore/ui/utils/locale-format";
import { ArrowRightLeft, TrendingUp } from "lucide-react";
import type { FC } from "react";

export interface CurrencyData {
    conversion?: {
        amount: number;
        convertedAmount: number;
        from: string;
        rate: number;
        relatedRates?: Record<string, number>;
        reverseRate: number;
        timestamp: string;
        to: string;
    };
    error?: string;
    success: boolean;
}

// Format numbers for display with proper grouping
const formatAmount = (value: number, locale: string): string => {
    if (value >= 1000) {
        return formatNumber(value, locale, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
    }

    // For small amounts, show more precision
    return formatNumber(value, locale, { maximumFractionDigits: 4, minimumFractionDigits: 2 });
};

const formatRate = (value: number): string => {
    if (value >= 100) {
        return value.toFixed(2);
    }

    if (value >= 1) {
        return value.toFixed(4);
    }

    return value.toFixed(6);
};

interface CurrencyWidgetProps {
    output: CurrencyData;
}

const CurrencyWidget: FC<CurrencyWidgetProps> = ({ output }) => {
    const { i18n, t } = useLingui();

    if (!output.success || !output.conversion) {
        return (
            <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-red-50 p-4 dark:bg-red-950/20">
                <p className="text-sm text-red-600 dark:text-red-400">{output.error ?? t`Failed to fetch currency conversion data.`}</p>
            </div>
        );
    }

    const { amount, convertedAmount, from, rate, relatedRates, reverseRate, timestamp, to } = output.conversion;
    const relatedEntries = relatedRates ? Object.entries(relatedRates).slice(0, 6) : [];

    return (
        <div className="my-2 w-full max-w-sm overflow-hidden rounded-xl border bg-gradient-to-br from-emerald-50 to-teal-50 dark:from-emerald-950/20 dark:to-teal-950/20">
            {/* Header */}
            <div className="flex items-center gap-2 p-4 pb-2">
                <ArrowRightLeft aria-hidden="true" className="size-4 text-emerald-600 dark:text-emerald-400" />
                <h3 className="text-sm font-semibold">
                    <Trans>Currency Conversion</Trans>
                </h3>
            </div>

            {/* Main conversion */}
            <div className="px-4 pb-3">
                <div className="flex items-baseline gap-2">
                    <span className="text-2xl font-bold tabular-nums">{formatAmount(amount, i18n.locale)}</span>
                    <span className="text-lg font-semibold text-emerald-700 dark:text-emerald-300">{from}</span>
                </div>
                <div className="mt-1 flex items-baseline gap-2">
                    <span className="text-muted-foreground text-sm">=</span>
                    <span className="text-2xl font-bold tabular-nums">{formatAmount(convertedAmount, i18n.locale)}</span>
                    <span className="text-lg font-semibold text-teal-700 dark:text-teal-300">{to}</span>
                </div>
            </div>

            {/* Exchange rate details */}
            <div className="flex items-center gap-4 border-t px-4 py-2.5 text-xs">
                <span className="text-muted-foreground">
                    1 {from} = {formatRate(rate)} {to}
                </span>
                <span className="text-muted-foreground">
                    1 {to} = {formatRate(reverseRate)} {from}
                </span>
            </div>

            {/* Related rates */}
            {relatedEntries.length > 0 && (
                <div className="border-t px-4 py-2.5">
                    <div className="mb-1.5 flex items-center gap-1">
                        <TrendingUp aria-hidden="true" className="text-muted-foreground size-3" />
                        <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
                            <Trans>1 {from} in other currencies</Trans>
                        </span>
                    </div>
                    <div className="grid grid-cols-3 gap-x-3 gap-y-1">
                        {relatedEntries.map(([currency, currencyRate]) => (
                            <div className="flex items-baseline justify-between gap-1" key={currency}>
                                <span className="text-muted-foreground text-[11px]">{currency}</span>
                                <span className="text-[11px] font-medium tabular-nums">{formatRate(currencyRate)}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}

            {/* Timestamp */}
            {timestamp && (
                <div className="border-t px-4 py-1.5">
                    <span className="text-muted-foreground text-[10px]">
                        <Trans>Updated: {timestamp}</Trans>
                    </span>
                </div>
            )}
        </div>
    );
};

export default CurrencyWidget;
