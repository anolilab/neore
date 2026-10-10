/**
 * Currency Converter Tool
 * Convert between currencies using exchange rate APIs
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { VALYU_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import { fetchWithTimeout, withRetry } from "./utilities";

export interface ConversionResult {
    amount: number;
    convertedAmount: number;
    from: string;
    rate: number;
    relatedRates?: Record<string, number>;
    reverseRate: number;
    timestamp: string;
    to: string;
}

/**
 * Fetch exchange rates from open API
 */
const POPULAR_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "CAD", "AUD", "CHF", "CNY", "INR", "KRW"];

const fetchExchangeRate = async (
    baseCurrency: string,
    targetCurrency: string,
): Promise<{ date: string; rate: number; relatedRates: Record<string, number> }> => {
    // Try exchangerate-api.com (free tier)
    const response = await fetchWithTimeout(`https://api.exchangerate-api.com/v4/latest/${baseCurrency.toUpperCase()}`);

    await assertOk(response, "Exchange rate API error");

    const data = (await response.json()) as { date: string; rates: Record<string, number> };
    const rate = data.rates[targetCurrency.toUpperCase()];

    if (!rate) {
        throw new Error(`Currency ${targetCurrency} not found`);
    }

    // Collect related rates for popular currencies (excluding base & target)
    const relatedRates: Record<string, number> = {};

    for (const currency of POPULAR_CURRENCIES) {
        if (currency !== baseCurrency.toUpperCase() && currency !== targetCurrency.toUpperCase() && data.rates[currency]) {
            relatedRates[currency] = data.rates[currency];
        }
    }

    return { date: data.date, rate, relatedRates };
};

/**
 * Fetch exchange rate using Valyu API (if available).
 */
const fetchExchangeRateWithValyu = async (baseCurrency: string, targetCurrency: string): Promise<{ rate: number; reverseRate: number } | null> => {
    if (!VALYU_API_KEY) {
        return null;
    }

    try {
        const response = await fetchWithTimeout(`https://api.valyu.network/v1/forex/rate?base=${baseCurrency}&quote=${targetCurrency}`, {
            headers: {
                Authorization: `Bearer ${VALYU_API_KEY}`,
            },
        });

        if (!response.ok) {
            await response.body?.cancel();

            return null;
        }

        const data = (await response.json()) as { rate: number; reverseRate?: number };

        return {
            rate: data.rate,
            reverseRate: data.reverseRate ?? 1 / data.rate,
        };
    } catch {
        return null;
    }
};

/**
 * Convert between different currencies.
 *
 * Calls `api.exchangerate-api.com`.
 */
const getSupportedCurrencies = async (): Promise<string[]> => {
    const response = await fetchWithTimeout("https://api.exchangerate-api.com/v4/latest/USD");

    if (!response.ok) {
        await response.body?.cancel();

        return [];
    }

    const data = (await response.json()) as { rates: Record<string, number> };

    return Object.keys(data.rates);
};

/**
 * Convert between different currencies.
 */
export const currencyConverterTool = createTool<
    {
        amount?: number;
        from: string;
        to: string;
    },
    {
        conversion?: ConversionResult;
        error?: string;
        success: boolean;
    },
    ToolContext
>({
    description:
        "Convert between different currencies. Supports major world currencies and provides current exchange rates. Use 3-letter ISO currency codes (e.g., USD, EUR, GBP, JPY).",
    execute: async (_context, input) => {
        const { amount = 1, from, to } = input;

        const fromUpper = from.toUpperCase();
        const toUpper = to.toUpperCase();

        if (fromUpper === toUpper) {
            return {
                conversion: {
                    amount,
                    convertedAmount: amount,
                    from: fromUpper,
                    rate: 1,
                    reverseRate: 1,
                    timestamp: new Date().toISOString(),
                    to: toUpper,
                },
                success: true,
            };
        }

        try {
            // Try Valyu first if available
            const valyuResult = await fetchExchangeRateWithValyu(fromUpper, toUpper);

            if (valyuResult) {
                return {
                    conversion: {
                        amount,
                        convertedAmount: amount * valyuResult.rate,
                        from: fromUpper,
                        rate: valyuResult.rate,
                        reverseRate: valyuResult.reverseRate,
                        timestamp: new Date().toISOString(),
                        to: toUpper,
                    },
                    success: true,
                };
            }

            // Fallback to free exchange rate API
            const { date, rate, relatedRates } = await withRetry(() => fetchExchangeRate(fromUpper, toUpper), { maxRetries: 2 });

            return {
                conversion: {
                    amount,
                    convertedAmount: amount * rate,
                    from: fromUpper,
                    rate,
                    relatedRates,
                    reverseRate: 1 / rate,
                    timestamp: date,
                    to: toUpper,
                },
                success: true,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to convert currency",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            amount: z.number().positive().optional().default(1).meta({ description: "Amount to convert (default: 1)" }),
            from: z.string().length(3).meta({ description: "Source currency code (e.g., USD, EUR, GBP)" }),
            to: z.string().length(3).meta({ description: "Target currency code (e.g., USD, EUR, GBP)" }),
        })
        .strict(),
    title: "Currency Converter",
});

/**
 * List Supported Currencies Tool
 */
export const listCurrenciesTool = createTool<
    Record<string, never>,
    {
        count: number;
        currencies: string[];
    },
    ToolContext
>({
    description: "Get a list of all supported currency codes for conversion.",
    execute: async () => {
        const currencies = await withRetry(() => getSupportedCurrencies(), { maxRetries: 2 });

        return {
            count: currencies.length,
            currencies,
        };
    },
    inputSchema: z.object({}).strict(),
    title: "List Currencies",
});
