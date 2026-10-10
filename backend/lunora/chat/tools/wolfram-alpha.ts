/**
 * Wolfram Alpha Tool
 * Performs computational queries using the Wolfram Alpha Short Answers API
 * and Full Results API for math, science, data analysis, and factual lookups.
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { assertOk } from "../../lib/fetch-timeout";
import { toolsLogger } from "../../lib/logger";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, formatError } from "./utilities";

// Wolfram Alpha App ID — stored as optional env var
const { WOLFRAM_APP_ID } = process.env;

interface WolframPod {
    primary?: boolean;
    subpods: {
        img?: { alt: string; height: number; src: string; width: number };
        plaintext?: string;
    }[];
    title: string;
}

interface WolframFullResult {
    queryresult: {
        didyoumeans?: { score: string; val: string }[];
        error: boolean;
        pods?: WolframPod[];
        success: boolean;
        tips?: { text: string };
    };
}

/**
 * Query Wolfram Alpha Full Results API for structured pod data.
 */
const queryWolframFull = async (
    query: string,
    appId: string,
): Promise<{
    pods: { isPrimary: boolean; text: string; title: string }[];
    success: boolean;
    suggestion?: string;
}> => {
    const params = new URLSearchParams({
        appid: appId,
        format: "plaintext",
        input: query,
        output: "json",
    });

    const response = await fetchWithTimeout(`https://api.wolframalpha.com/v2/query?${params.toString()}`, undefined, 15_000);

    await assertOk(response, "Wolfram Alpha API error");

    const data = (await response.json()) as WolframFullResult;
    const qr = data.queryresult;

    if (!qr.success || qr.error) {
        return {
            pods: [],
            success: false,
            suggestion: qr.didyoumeans?.[0]?.val ?? qr.tips?.text,
        };
    }

    const pods = (qr.pods ?? []).map((pod) => {
        return {
            isPrimary: pod.primary ?? false,
            text: pod.subpods
                .map((sp) => sp.plaintext)
                .filter(Boolean)
                .join("\n"),
            title: pod.title,
        };
    });

    return { pods, success: true };
};

/**
 * Query Wolfram Alpha Short Answers API for a quick one-line response.
 */
const queryWolframShort = async (query: string, appId: string): Promise<string> => {
    const params = new URLSearchParams({
        appid: appId,
        i: query,
    });

    const response = await fetchWithTimeout(`https://api.wolframalpha.com/v1/result?${params.toString()}`, undefined, 10_000);

    if (!response.ok) {
        await response.body?.cancel();

        if (response.status === 501) {
            return ""; // No short answer available
        }

        throw new Error(`Wolfram Alpha Short API error: ${response.status}`);
    }

    return response.text();
};

/**
 * Wolfram Alpha Computation Tool
 */
const wolframAlphaTool = createTool<
    {
        mode?: "full" | "short";
        query: string;
    },
    {
        pods: { isPrimary: boolean; text: string; title: string }[];
        query: string;
        shortAnswer?: string;
        success: boolean;
        suggestion?: string;
    },
    ToolContext
>({
    description: `Query Wolfram Alpha for computational answers, math calculations, unit conversions, scientific data, statistics, and factual lookups.
Best for: mathematical expressions, equations, unit conversions, chemical formulas, physics calculations, data analysis, nutritional info, geographical facts.
Use "short" mode for quick calculations, "full" mode for detailed breakdowns.`,
    execute: async (_context, input) => {
        if (!WOLFRAM_APP_ID) {
            return {
                pods: [],
                query: input.query,
                success: false,
                suggestion: "Wolfram Alpha is not configured. Please set WOLFRAM_APP_ID environment variable.",
            };
        }

        const { mode = "full", query } = input;

        try {
            if (mode === "short") {
                const shortAnswer = await queryWolframShort(query, WOLFRAM_APP_ID);

                return {
                    pods: [],
                    query,
                    shortAnswer: shortAnswer || undefined,
                    success: !!shortAnswer,
                };
            }

            // Full mode — get detailed pod data
            const result = await queryWolframFull(query, WOLFRAM_APP_ID);

            // Also try short answer for a quick summary
            let shortAnswer: string | undefined;

            try {
                shortAnswer = (await queryWolframShort(query, WOLFRAM_APP_ID)) || undefined;
            } catch {
                // Short answer is optional
            }

            return {
                pods: result.pods,
                query,
                shortAnswer,
                success: result.success,
                suggestion: result.suggestion,
            };
        } catch (error) {
            toolsLogger.error(`Wolfram Alpha query failed for "${query}":`, formatError(error));

            return {
                pods: [],
                query,
                success: false,
                suggestion: `Query failed: ${formatError(error)}`,
            };
        }
    },
    inputSchema: z
        .object({
            mode: z.enum(["full", "short"]).optional().default("full").meta({ description: "Query mode: 'short' for quick answer, 'full' for detailed pods" }),
            query: z
                .string()
                .min(1)
                .max(500)
                .meta({ description: "The query to compute or look up (e.g., 'integrate x^2 dx', '100 USD to EUR', 'population of France')" }),
        })
        .strict(),
    title: "Wolfram Alpha",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default wolframAlphaTool;
