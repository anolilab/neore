/**
 * Stock Chart Tool
 * Get stock data and financial information
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { VALYU_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, withRetry } from "./utilities";

export interface StockPrice {
    close: number;
    date: string;
    high: number;
    low: number;
    open: number;
    volume: number;
}

export interface StockQuote {
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
}

export interface StockNews {
    publishedAt: string;
    source: string;
    summary?: string;
    title: string;
    url: string;
}

interface ValyuStockQuote {
    change: number;
    changePercent: number;
    dayHigh: number;
    dayLow: number;
    dividendYield?: number;
    fiftyTwoWeekHigh?: number;
    fiftyTwoWeekLow?: number;
    marketCap?: number;
    name?: string;
    open: number;
    peRatio?: number;
    previousClose: number;
    price: number;
    symbol: string;
    volume: number;
}

interface ValyuHistoricalData {
    close: number;
    date: string;
    high: number;
    low: number;
    open: number;
    volume: number;
}

interface ValyuStockResponse {
    historical?: ValyuHistoricalData[];
    news?: {
        publishedAt: string;
        source: string;
        summary?: string;
        title: string;
        url: string;
    }[];
    quote: ValyuStockQuote;
}

/**
 * Fetch stock data using Valyu API.
 */
const fetchStockData = async (
    symbol: string,
    options: {
        historicalDays?: number;
        includeHistorical?: boolean;
        includeNews?: boolean;
    } = {},
): Promise<{
    historical?: StockPrice[];
    news?: StockNews[];
    quote: StockQuote;
}> => {
    if (!VALYU_API_KEY) {
        throw new Error("VALYU_API_KEY is not configured");
    }

    const params = new URLSearchParams({
        symbol: symbol.toUpperCase(),
    });

    if (options.includeHistorical) {
        params.append("historical", "true");
        params.append("days", (options.historicalDays ?? 30).toString());
    }

    if (options.includeNews) {
        params.append("news", "true");
    }

    const response = await fetchWithTimeout(`https://api.valyu.network/v1/stocks/quote?${params.toString()}`, {
        headers: {
            Authorization: `Bearer ${VALYU_API_KEY}`,
        },
    });

    await assertOk(response, "Valyu API error");

    const data = (await response.json()) as ValyuStockResponse;

    const quote: StockQuote = {
        change: data.quote.change,
        changePercent: data.quote.changePercent,
        dividendYield: data.quote.dividendYield,
        high: data.quote.dayHigh,
        low: data.quote.dayLow,
        marketCap: data.quote.marketCap,
        name: data.quote.name,
        open: data.quote.open,
        peRatio: data.quote.peRatio,
        previousClose: data.quote.previousClose,
        price: data.quote.price,
        symbol: data.quote.symbol,
        volume: data.quote.volume,
        week52High: data.quote.fiftyTwoWeekHigh,
        week52Low: data.quote.fiftyTwoWeekLow,
    };

    const result: {
        historical?: StockPrice[];
        news?: StockNews[];
        quote: StockQuote;
    } = { quote };

    if (data.historical) {
        result.historical = data.historical.map((h) => {
            return {
                close: h.close,
                date: h.date,
                high: h.high,
                low: h.low,
                open: h.open,
                volume: h.volume,
            };
        });
    }

    if (data.news) {
        result.news = data.news.map((n) => {
            return {
                publishedAt: n.publishedAt,
                source: n.source,
                summary: n.summary,
                title: n.title,
                url: n.url,
            };
        });
    }

    return result;
};

/**
 * Fallback: Fetch stock data using free API (Alpha Vantage style).
 */
const fetchStockDataFallback = async (symbol: string): Promise<StockQuote | null> => {
    // Try Yahoo Finance unofficial API
    try {
        const response = await fetchWithTimeout(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=1d`);

        if (!response.ok) {
            await response.body?.cancel();

            return null;
        }

        const data = (await response.json()) as {
            chart: {
                result: {
                    meta: {
                        fiftyTwoWeekHigh?: number;
                        fiftyTwoWeekLow?: number;
                        previousClose: number;
                        regularMarketDayHigh: number;
                        regularMarketDayLow: number;
                        regularMarketOpen: number;
                        regularMarketPrice: number;
                        regularMarketVolume: number;
                        shortName?: string;
                        symbol: string;
                    };
                }[];
            };
        };

        const result = data.chart.result?.[0];

        if (!result) {
            return null;
        }

        const { meta } = result;
        const change = meta.regularMarketPrice - meta.previousClose;

        return {
            change,
            changePercent: (change / meta.previousClose) * 100,
            high: meta.regularMarketDayHigh,
            low: meta.regularMarketDayLow,
            name: meta.shortName,
            open: meta.regularMarketOpen,
            previousClose: meta.previousClose,
            price: meta.regularMarketPrice,
            symbol: meta.symbol,
            volume: meta.regularMarketVolume,
            week52High: meta.fiftyTwoWeekHigh,
            week52Low: meta.fiftyTwoWeekLow,
        };
    } catch {
        return null;
    }
};

/**
 * Get stock market data including current price, historical data, and news.
 */
const stockChartTool = createTool<
    {
        historicalDays?: number;
        includeHistorical?: boolean;
        includeNews?: boolean;
        symbol: string;
    },
    {
        error?: string;
        historical?: StockPrice[];
        news?: StockNews[];
        quote?: StockQuote;
        success: boolean;
    },
    ToolContext
>({
    description: "Get stock market data including current price, historical data, and news. Provide a stock ticker symbol (e.g., AAPL, GOOGL, MSFT).",
    execute: async (_context, input) => {
        const { historicalDays = 30, includeHistorical = false, includeNews = false, symbol } = input;

        try {
            // Try Valyu API first
            if (VALYU_API_KEY) {
                const data = await withRetry(
                    () =>
                        fetchStockData(symbol, {
                            historicalDays,
                            includeHistorical,
                            includeNews,
                        }),
                    { maxRetries: 2 },
                );

                return {
                    historical: data.historical,
                    news: data.news,
                    quote: data.quote,
                    success: true,
                };
            }

            // Fallback to free API
            const quote = await withRetry(() => fetchStockDataFallback(symbol), { maxRetries: 2 });

            if (!quote) {
                return {
                    error: `Stock ${symbol} not found or API unavailable`,
                    success: false,
                };
            }

            return {
                quote,
                success: true,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to fetch stock data",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            historicalDays: z
                .number()
                .min(1)
                .max(365)
                .optional()
                .default(30)
                .meta({ description: "Number of days of historical data (if includeHistorical is true)" }),
            includeHistorical: z.boolean().optional().default(false).meta({ description: "Include historical price data" }),
            includeNews: z.boolean().optional().default(false).meta({ description: "Include recent news about the stock" }),
            symbol: z.string().min(1).max(10).meta({ description: "Stock ticker symbol (e.g., AAPL, GOOGL, MSFT)" }),
        })
        .strict(),
    title: "Stock Chart",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default stockChartTool;
