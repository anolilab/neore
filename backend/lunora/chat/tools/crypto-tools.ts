/**
 * Crypto Tools
 * Cryptocurrency data retrieval using CoinGecko API
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { COINGECKO_API_KEY } from "../../env";
import { assertOk } from "../../lib/fetch-timeout";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, withRetry } from "./utilities";

const COINGECKO_BASE_URL = "https://api.coingecko.com/api/v3";

export interface CoinData {
    categories?: string[];
    description?: string;
    id: string;
    image?: {
        large?: string;
        small?: string;
        thumb?: string;
    };
    lastUpdated?: string;
    links?: {
        github?: string[];
        homepage?: string[];
        reddit?: string;
        telegram?: string;
        twitter?: string;
    };
    marketData?: {
        ath?: Record<string, number>;
        athDate?: Record<string, string>;
        atl?: Record<string, number>;
        atlDate?: Record<string, string>;
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
}

export interface OHLCData {
    close: number;
    high: number;
    low: number;
    open: number;
    timestamp: number;
}

interface CoinGeckoOHLC {
    0: number; // timestamp
    1: number; // open
    2: number; // high
    3: number; // low
    4: number; // close
}

/** The subset of CoinGecko's `market_data` object this module reads. */
interface CoinGeckoMarketData {
    ath?: Record<string, number>;
    ath_date?: Record<string, string>;
    atl?: Record<string, number>;
    atl_date?: Record<string, string>;
    circulating_supply?: number;
    current_price?: Record<string, number>;
    high_24h?: Record<string, number>;
    low_24h?: Record<string, number>;
    market_cap?: Record<string, number>;
    max_supply?: number;
    price_change_percentage_7d?: number;
    price_change_percentage_24h?: number;
    price_change_percentage_30d?: number;
    total_supply?: number;
    total_volume?: Record<string, number>;
}

/** The subset of CoinGecko's `/coins/{id}` response this module reads. */
interface CoinGeckoCoinResponse {
    categories?: string[];
    description?: Record<string, string>;
    id: string;
    image?: CoinData["image"];
    last_updated?: string;
    links?: {
        homepage?: string[];
        repos_url?: { github?: string[] };
        subreddit_url?: string;
        telegram_channel_identifier?: string;
        twitter_screen_name?: string;
    };
    market_data?: CoinGeckoMarketData;
    name: string;
    symbol: string;
}

/**
 * Build API headers with optional API key.
 */
const buildHeaders = (): Record<string, string> => {
    const headers: Record<string, string> = {
        Accept: "application/json",
    };

    if (COINGECKO_API_KEY) {
        headers["x-cg-demo-api-key"] = COINGECKO_API_KEY;
    }

    return headers;
};

/**
 * Fetch coin data by ID.
 */
const fetchCoinData = async (
    coinId: string,
    options: {
        communityData?: boolean;
        developerData?: boolean;
        localization?: boolean;
        marketData?: boolean;
        tickers?: boolean;
    } = {},
): Promise<CoinData> => {
    const params = new URLSearchParams({
        community_data: (options.communityData ?? false).toString(),
        developer_data: (options.developerData ?? false).toString(),
        localization: (options.localization ?? false).toString(),
        market_data: (options.marketData ?? true).toString(),
        tickers: (options.tickers ?? false).toString(),
    });

    const response = await fetchWithTimeout(`${COINGECKO_BASE_URL}/coins/${coinId}?${params.toString()}`, {
        headers: buildHeaders(),
    });

    await assertOk(response, "CoinGecko API error");

    const data = (await response.json()) as CoinGeckoCoinResponse;

    return {
        categories: data.categories,
        description: data.description?.en,
        id: data.id,
        image: data.image,
        lastUpdated: data.last_updated,
        links: data.links
            ? {
                  github: data.links.repos_url ? data.links.repos_url.github : undefined,
                  homepage: data.links.homepage,
                  reddit: data.links.subreddit_url,
                  telegram: data.links.telegram_channel_identifier,
                  twitter: data.links.twitter_screen_name,
              }
            : undefined,
        marketData: data.market_data
            ? {
                  ath: data.market_data.ath,
                  athDate: data.market_data.ath_date,
                  atl: data.market_data.atl,
                  atlDate: data.market_data.atl_date,
                  circulatingSupply: data.market_data.circulating_supply,
                  currentPrice: data.market_data.current_price,
                  high24h: data.market_data.high_24h,
                  low24h: data.market_data.low_24h,
                  marketCap: data.market_data.market_cap,
                  maxSupply: data.market_data.max_supply,
                  priceChangePercentage7d: data.market_data.price_change_percentage_7d,
                  priceChangePercentage24h: data.market_data.price_change_percentage_24h,
                  priceChangePercentage30d: data.market_data.price_change_percentage_30d,
                  totalSupply: data.market_data.total_supply,
                  totalVolume: data.market_data.total_volume,
              }
            : undefined,
        name: data.name,
        symbol: data.symbol,
    };
};

/**
 * Fetch OHLC data.
 */
const fetchOHLCData = async (coinId: string, vsCurrency: string, days: number): Promise<OHLCData[]> => {
    const response = await fetchWithTimeout(`${COINGECKO_BASE_URL}/coins/${coinId}/ohlc?vs_currency=${vsCurrency}&days=${days}`, {
        headers: buildHeaders(),
    });

    await assertOk(response, "CoinGecko API error");

    const data = (await response.json()) as CoinGeckoOHLC[];

    return data.map((item) => {
        return {
            close: item[4],
            high: item[2],
            low: item[3],
            open: item[1],
            timestamp: item[0],
        };
    });
};

/**
 * Fetch coin data by contract address.
 */
const fetchCoinByContract = async (platform: string, contractAddress: string): Promise<CoinData> => {
    const response = await fetchWithTimeout(`${COINGECKO_BASE_URL}/coins/${platform}/contract/${contractAddress}`, {
        headers: buildHeaders(),
    });

    await assertOk(response, "CoinGecko API error");

    const data = (await response.json()) as CoinGeckoCoinResponse;

    return {
        description: data.description?.en,
        id: data.id,
        image: data.image,
        lastUpdated: data.last_updated,
        marketData: data.market_data
            ? {
                  currentPrice: data.market_data.current_price,
                  marketCap: data.market_data.market_cap,
                  priceChangePercentage24h: data.market_data.price_change_percentage_24h,
              }
            : undefined,
        name: data.name,
        symbol: data.symbol,
    };
};

/**
 * Get comprehensive data about a cryptocurrency by its CoinGecko ID (e.g., 'bitcoin', 'ethereum').
 */
export const coinDataTool = createTool<
    {
        coinId: string;
        includeCommunityData?: boolean;
        includeMarketData?: boolean;
    },
    {
        data?: CoinData;
        error?: string;
        success: boolean;
    },
    ToolContext
>({
    description:
        "Get comprehensive data about a cryptocurrency by its CoinGecko ID (e.g., 'bitcoin', 'ethereum'). Returns price, market cap, supply, and other metrics.",
    execute: async (_context, input) => {
        const { coinId, includeCommunityData = false, includeMarketData = true } = input;

        try {
            const data = await withRetry(
                () =>
                    fetchCoinData(coinId, {
                        communityData: includeCommunityData,
                        marketData: includeMarketData,
                    }),
                { maxRetries: 2 },
            );

            return { data, success: true };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to fetch coin data",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            coinId: z.string().min(1).meta({ description: "CoinGecko coin ID (e.g., 'bitcoin', 'ethereum', 'solana')" }),
            includeCommunityData: z.boolean().optional().default(false).meta({ description: "Include community data" }),
            includeMarketData: z.boolean().optional().default(true).meta({ description: "Include market data (price, volume, etc.)" }),
        })
        .strict(),
    title: "Cryptocurrency Data",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

/**
 * Get cryptocurrency data by its contract address on a specific blockchain platform.
 */
export const coinDataByContractTool = createTool<
    {
        contractAddress: string;
        platform: string;
    },
    {
        data?: CoinData;
        error?: string;
        success: boolean;
    },
    ToolContext
>({
    description: "Get cryptocurrency data by its contract address on a specific blockchain platform.",
    execute: async (_context, input) => {
        const { contractAddress, platform } = input;

        try {
            const data = await withRetry(() => fetchCoinByContract(platform, contractAddress), { maxRetries: 2 });

            return { data, success: true };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to fetch coin data",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            contractAddress: z.string().min(1).meta({ description: "Token contract address" }),
            platform: z
                .string()
                .min(1)
                .meta({ description: "Platform ID (e.g., 'ethereum', 'binance-smart-chain', 'polygon-pos', 'arbitrum-one', 'avalanche')" }),
        })
        .strict(),
    title: "Cryptocurrency by Contract",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

/**
 * Get OHLC (Open, High, Low, Close) candlestick data for a cryptocurrency along with comprehensive coin data.
 */
export const coinOhlcTool = createTool<
    {
        coinId: string;
        days?: number;
        vsCurrency?: string;
    },
    {
        coinData?: CoinData;
        error?: string;
        ohlcData?: OHLCData[];
        success: boolean;
    },
    ToolContext
>({
    description: "Get OHLC (Open, High, Low, Close) candlestick data for a cryptocurrency along with comprehensive coin data.",
    execute: async (_context, input) => {
        const { coinId, days = 30, vsCurrency = "usd" } = input;

        try {
            const [coinData, ohlcData] = await Promise.all([
                withRetry(() => fetchCoinData(coinId, { marketData: true }), { maxRetries: 2 }),
                withRetry(() => fetchOHLCData(coinId, vsCurrency, days), { maxRetries: 2 }),
            ]);

            return {
                coinData,
                ohlcData,
                success: true,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Failed to fetch OHLC data",
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            coinId: z.string().min(1).meta({ description: "CoinGecko coin ID (e.g., 'bitcoin', 'ethereum')" }),
            days: z.number().min(1).max(365).optional().default(30).meta({ description: "Number of days (1-365)" }),
            vsCurrency: z.string().optional().default("usd").meta({ description: "Target currency (e.g., 'usd', 'eur', 'btc')" }),
        })
        .strict(),
    title: "Cryptocurrency OHLC Chart",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});
