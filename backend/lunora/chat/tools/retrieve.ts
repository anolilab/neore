import z from "zod/v4";

import { internal } from "../../_generated/internal";

/**
 * Retrieve Tool
 * Extracts content from URLs using multiple providers
 */
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, FIRECRAWL_API_KEY } from "../../env";
import { checkRateLimit } from "../../lib/rate-limiter";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, formatError, truncateText, withRetry } from "./utilities";

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const TITLE_TAG_RE = /<title[^>]*>([^<]+)<\/title>/i;
const META_DESCRIPTION_RE = /<meta[^>]*name=["']description["'][^>]*content=["']([^"']+)["']/i;
const META_DESCRIPTION_RE_2 = /<meta[^>]*property=["']og:description["'][^>]*content=["']([^"']+)["']/i;
const PATTERN_RE = /<body[^>]*>([\s\S]*?)<\/body>/i;

export interface RetrievedContent {
    author?: string;
    content: string;
    description?: string;
    images?: string[];
    language?: string;
    publishedDate?: string;
    title: string;
    type: "article" | "video" | "social" | "other";
    url: string;
}

interface ExaContentsResult {
    author?: string;
    publishedDate?: string;
    text?: string;
    title: string;
    url: string;
}

interface FirecrawlScrapeResult {
    data: {
        content?: string;
        markdown?: string;
        metadata?: {
            author?: string;
            description?: string;
            language?: string;
            ogImage?: string;
            publishedDate?: string;
            title?: string;
        };
    };
}

/**
 * Reject URLs that target internal/private network ranges or non-HTTP(S) schemes.
 * Defends against SSRF when the LLM is tricked into supplying a malicious URL.
 */
const isSafePublicUrl = (rawUrl: string): boolean => {
    let parsed: URL;

    try {
        parsed = new URL(rawUrl);
    } catch {
        return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return false;
    }

    const hostname = parsed.hostname.toLowerCase();

    if (!hostname) {
        return false;
    }

    // Reject literal localhost names
    if (
        hostname === "localhost" ||
        hostname === "0.0.0.0" ||
        hostname.endsWith(".localhost") ||
        hostname.endsWith(".internal") ||
        hostname.endsWith(".local")
    ) {
        return false;
    }

    // Reject IPv6 link-local / loopback / private ranges (any [::]-style hostname is suspicious)
    if (hostname.startsWith("[")) {
        return false;
    }

    // Reject IPv4 in private/reserved ranges
    const ipv4 = hostname.match(IPV4_RE);

    if (ipv4) {
        const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];

        if (
            a === 10 || // 10.0.0.0/8
            a === 127 || // 127.0.0.0/8 loopback
            a === 0 || // 0.0.0.0/8
            (a === 169 && b === 254) || // 169.254.0.0/16 link-local incl. cloud metadata
            (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
            (a === 192 && b === 168) || // 192.168.0.0/16
            (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 CGNAT
            a >= 224 // multicast / reserved
        ) {
            return false;
        }
    }

    return true;
};

/**
 * Detect content type from URL.
 */
const detectContentType = (url: string): "video" | "social" | "article" | "other" => {
    const urlLower = url.toLowerCase();

    // Video platforms
    if (urlLower.includes("youtube.com") || urlLower.includes("youtu.be") || urlLower.includes("vimeo.com") || urlLower.includes("tiktok.com")) {
        return "video";
    }

    // Social media
    if (
        urlLower.includes("twitter.com") ||
        urlLower.includes("x.com") ||
        urlLower.includes("instagram.com") ||
        urlLower.includes("facebook.com") ||
        urlLower.includes("linkedin.com") ||
        urlLower.includes("reddit.com")
    ) {
        return "social";
    }

    return "article";
};

/**
 * Retrieve content using Exa API.
 */
const retrieveWithExa = async (url: string): Promise<RetrievedContent | null> => {
    if (!EXA_API_KEY) {
        return null;
    }

    try {
        const response = await fetchWithTimeout("https://api.exa.ai/contents", {
            body: JSON.stringify({
                text: { max_characters: 10_000 },
                urls: [url],
            }),
            headers: {
                "Content-Type": "application/json",
                "x-api-key": EXA_API_KEY,
            },
            method: "POST",
        });

        if (!response.ok) {
            await response.body?.cancel();

            return null;
        }

        const data = (await response.json()) as { results: ExaContentsResult[] };
        const result = data.results[0];

        if (!result) {
            return null;
        }

        return {
            author: result.author,
            content: result.text ?? "",
            publishedDate: result.publishedDate,
            title: result.title,
            type: detectContentType(url),
            url: result.url,
        };
    } catch {
        return null;
    }
};

/**
 * Retrieve content using Firecrawl API.
 */
const retrieveWithFirecrawl = async (url: string, apiKey?: string): Promise<RetrievedContent | null> => {
    const effectiveKey = apiKey || FIRECRAWL_API_KEY;

    if (!effectiveKey) {
        return null;
    }

    try {
        const response = await fetchWithTimeout("https://api.firecrawl.dev/v1/scrape", {
            body: JSON.stringify({
                formats: ["markdown"],
                url,
            }),
            headers: {
                Authorization: `Bearer ${effectiveKey}`,
                "Content-Type": "application/json",
            },
            method: "POST",
        });

        if (!response.ok) {
            await response.body?.cancel();

            return null;
        }

        const result = (await response.json()) as FirecrawlScrapeResult;
        const content = result.data.markdown ?? result.data.content ?? "";

        return {
            author: result.data.metadata?.author,
            content,
            description: result.data.metadata?.description,
            images: result.data.metadata?.ogImage ? [result.data.metadata.ogImage] : undefined,
            language: result.data.metadata?.language,
            publishedDate: result.data.metadata?.publishedDate,
            title: result.data.metadata?.title ?? url,
            type: detectContentType(url),
            url,
        };
    } catch {
        return null;
    }
};

/**
 * Retrieve content using basic fetch (fallback).
 */
const retrieveWithFetch = async (url: string): Promise<RetrievedContent | null> => {
    if (!isSafePublicUrl(url)) {
        return null;
    }

    try {
        const response = await fetchWithTimeout(url, {
            headers: {
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "User-Agent": "Mozilla/5.0 (compatible; NeoreBot/1.0)",
            },
        });

        if (!response.ok) {
            // Cancel the body we are about to discard — an unread response
            // stream leaves the runtime holding a socket nobody drains, which
            // `wrangler dev` escalates into a fatal `Network connection lost.`
            // (see the changelog fetch in `changelog/functions.ts`).
            await response.body?.cancel();

            return null;
        }

        const contentType = response.headers.get("content-type") ?? "";

        if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
            // Not a document we can parse — cancel rather than leak the stream.
            await response.body?.cancel();

            return null;
        }

        const html = await response.text();

        // Simple HTML parsing
        const titleMatch = html.match(TITLE_TAG_RE);
        const descMatch = html.match(META_DESCRIPTION_RE);
        const ogDescMatch = html.match(META_DESCRIPTION_RE_2);

        // Extract text content (basic approach)
        const bodyMatch = html.match(PATTERN_RE);
        let content = bodyMatch?.[1] ?? html;

        // Remove scripts and styles
        content = content.replaceAll(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
        content = content.replaceAll(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
        content = content.replaceAll(/<[^<>]*>/g, " ");
        content = content.replaceAll(/\s+/g, " ").trim();

        return {
            content: truncateText(content, 10_000),
            description: ogDescMatch?.[1] ?? descMatch?.[1],
            title: titleMatch?.[1]?.trim() ?? url,
            type: detectContentType(url),
            url,
        };
    } catch {
        return null;
    }
};

/**
 * Extract and retrieve content from web URLs.
 */
const retrieveTool = createTool<
    {
        maxContentLength?: number;
        urls: string[];
    },
    {
        failureCount: number;
        results: {
            content?: RetrievedContent;
            error?: string;
            success: boolean;
            url: string;
        }[];
        successCount: number;
    },
    ToolContext
>({
    description:
        "Extract and retrieve content from web URLs. Supports articles, blog posts, and web pages. Returns extracted text content, metadata, and relevant information.",
    execute: async (context, input) => {
        const { maxContentLength = 10_000 } = input;
        let { urls } = input;

        if (!context.userId) {
            return {
                failureCount: urls.length,
                results: urls.map((url) => {
                    return { error: "Authentication required", success: false, url };
                }),
                successCount: 0,
            };
        }

        // Lazy-fetch user's Firecrawl key (BYOK), fall back to env key
        let userFirecrawlKey: string | undefined;

        try {
            const userToolKeys = await context.runQuery(internal.auth.functions.getDecryptedToolKeysQuery, { userId: context.userId });

            userFirecrawlKey = userToolKeys["firecrawl"];
        } catch {
            // fallback to env key
        }

        // Per-user/day budget: charge once per URL. BYOK Firecrawl users
        // get the higher premium bucket — their own quota absorbs cost,
        // the platform's Exa + env-key Firecrawl path is what we cap.
        const isPremium = context.userTier === "premium" || context.userTier === "ultra" || !!userFirecrawlKey;
        const tier = isPremium ? "premium" : "free";

        // Lower the per-call URL ceiling for the platform-key path so a
        // single tool call cannot drain a large slice of the daily quota
        // in one shot. BYOK keeps the original schema cap of 10.
        const PLATFORM_PATH_PER_CALL_CAP = 3;

        if (!isPremium && urls.length > PLATFORM_PATH_PER_CALL_CAP) {
            urls = urls.slice(0, PLATFORM_PATH_PER_CALL_CAP);
        }

        const limited = await checkRateLimit(context, `chat/dailyRetrieve:${tier}`, {
            count: urls.length,
            key: context.userId,
            throws: false,
        });

        if (!limited.ok) {
            return {
                failureCount: urls.length,
                results: urls.map((url) => {
                    return { error: "Daily retrieve limit reached", success: false, url };
                }),
                successCount: 0,
            };
        }

        const results = await Promise.all(
            urls.map(async (url) => {
                // SSRF guard: reject internal/private/loopback hosts before any provider runs.
                if (!isSafePublicUrl(url)) {
                    return {
                        error: "URL rejected: only public http(s) URLs are allowed",
                        success: false,
                        url,
                    };
                }

                try {
                    // Try providers in order of preference
                    let content = await withRetry(() => retrieveWithExa(url), { maxRetries: 1 });

                    if (!content) {
                        content = await withRetry(() => retrieveWithFirecrawl(url, userFirecrawlKey), { maxRetries: 1 });
                    }

                    if (!content) {
                        content = await withRetry(() => retrieveWithFetch(url), { maxRetries: 1 });
                    }

                    if (!content) {
                        return {
                            error: "Failed to retrieve content from any provider",
                            success: false,
                            url,
                        };
                    }

                    // Truncate content if needed
                    if (content.content.length > maxContentLength) {
                        content.content = truncateText(content.content, maxContentLength);
                    }

                    return {
                        content,
                        success: true,
                        url,
                    };
                } catch (error) {
                    return {
                        error: formatError(error),
                        success: false,
                        url,
                    };
                }
            }),
        );

        const successCount = results.filter((r) => r.success).length;
        const failureCount = results.filter((r) => !r.success).length;

        return {
            failureCount,
            results,
            successCount,
        };
    },
    inputSchema: z
        .object({
            maxContentLength: z
                .number()
                .min(100)
                .max(50_000)
                .optional()
                .default(10_000)
                .meta({ description: "Maximum content length per URL (default: 10000)" }),
            urls: z.array(z.url()).min(1).max(10).meta({ description: "Array of URLs to retrieve content from" }),
        })
        .strict(),
    title: "Retrieve Content",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default retrieveTool;
