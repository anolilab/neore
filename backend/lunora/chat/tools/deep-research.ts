import type { LanguageModel } from "ai";

/**
 * Deep Research Tool
 *
 * Multi-step research pipeline that:
 * 1. Generates targeted search queries from the research topic
 * 2. Executes parallel web searches
 * 3. Retrieves full content from top sources
 * 4. Synthesizes findings into a structured research report
 * 5. Saves the report as a canvas document
 */
import { generateText, Output } from "ai";
import z from "zod/v4";

import { internal } from "../../_generated/internal";
import type { Id } from "../../_generated/dataModel";
import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { EXA_API_KEY, TAVILY_API_KEY } from "../../env";
import { toolsLogger } from "../../lib/logger";
import { deduplicateByDomainAndUrl, fetchWithTimeout, isSafeUrl, truncateText, withRetry } from "./utilities";
import type { WebSearchResult } from "./web-search";

const TRAILING_PERIOD_RE = /\.$/;
const TITLE_TAG_RE = /<title[^>]*>(.*?)<\/title>/i;

/**
 * Perform a web search for the research pipeline.
 */
const researchSearch = async (query: string, maxResults: number): Promise<WebSearchResult[]> => {
    // Try Tavily first (best for comprehensive research)
    if (TAVILY_API_KEY) {
        try {
            const response = await fetchWithTimeout("https://api.tavily.com/search", {
                body: JSON.stringify({
                    api_key: TAVILY_API_KEY,
                    include_answer: false,
                    include_images: false,
                    max_results: maxResults,
                    query,
                    search_depth: "advanced",
                    topic: "general",
                }),
                headers: { "Content-Type": "application/json" },
                method: "POST",
            });

            if (response.ok) {
                const data = (await response.json()) as { results: { content: string; published_date?: string; title: string; url: string }[] };

                return data.results.map((r) => {
                    return {
                        content: r.content,
                        publishedDate: r.published_date,
                        title: r.title,
                        url: r.url,
                    };
                });
            }

            await response.body?.cancel();
        } catch (error) {
            toolsLogger.warn(`[DeepResearch] Tavily search failed for "${query}":`, error);
        }
    }

    // Fallback to Exa
    if (EXA_API_KEY) {
        try {
            const response = await fetchWithTimeout("https://api.exa.ai/search", {
                body: JSON.stringify({
                    contents: { text: { max_characters: 3000 } },
                    num_results: maxResults,
                    query,
                    use_autoprompt: true,
                }),
                headers: {
                    "Content-Type": "application/json",
                    "x-api-key": EXA_API_KEY,
                },
                method: "POST",
            });

            if (response.ok) {
                const data = (await response.json()) as {
                    results: { author?: string; publishedDate?: string; text?: string; title: string; url: string }[];
                };

                return data.results.map((r) => {
                    return {
                        author: r.author,
                        content: r.text ?? "",
                        publishedDate: r.publishedDate,
                        title: r.title,
                        url: r.url,
                    };
                });
            }

            await response.body?.cancel();
        } catch (error) {
            toolsLogger.warn(`[DeepResearch] Exa search failed for "${query}":`, error);
        }
    }

    return [];
};

/**
 * Validate that a URL is safe to fetch. Also blocks `*.internal` and
 * `*.local` suffixes which are unique to deep-research's untrusted-URL
 * surface (LLMs hand back arbitrary hostnames here, so the domain-suffix
 * check is intentional). All other private/reserved-range checks come
 * from the canonical `isSafeUrl` (numeric CIDR coverage of 0/8, 10/8,
 * 100.64/10, 127/8, 169.254/16, 172.16/12, 192.168/16, multicast, etc.,
 * plus IPv6 loopback/link-local/ULA/multicast/IPv4-mapped).
 */
const isFetchableUrl = (url: string): boolean => {
    if (!isSafeUrl(url)) return false;

    try {
        const host = new URL(url).hostname.toLowerCase().replace(TRAILING_PERIOD_RE, "");

        return !(host.endsWith(".internal") || host.endsWith(".local"));
    } catch {
        return false;
    }
};

/**
 * Retrieve full page content for a URL.
 */
const retrieveContent = async (url: string): Promise<{ content: string; title: string } | null> => {
    if (!isFetchableUrl(url)) {
        return null;
    }

    try {
        const response = await fetchWithTimeout(
            url,
            {
                headers: {
                    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                    "User-Agent": "Mozilla/5.0 (compatible; NeoreResearchBot/1.0)",
                },
            },
            10_000,
        );

        if (!response.ok) {
            // Cancel the body we are about to discard — an unread response
            // stream leaves the runtime holding a socket nobody drains, which
            // `wrangler dev` escalates into a fatal `Network connection lost.`
            // (see the changelog fetch in `changelog/functions.ts`).
            await response.body?.cancel();

            return null;
        }

        const contentLength = response.headers.get("content-length");

        if (contentLength && Number.parseInt(contentLength, 10) > 2_000_000) {
            // Skip pages larger than 2MB — cancel rather than leak the stream.
            await response.body?.cancel();

            return null;
        }

        const html = await response.text();
        // Basic HTML to text extraction
        const textContent = html
            .replaceAll(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replaceAll(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replaceAll(/<nav[^>]*>[\s\S]*?<\/nav>/gi, "")
            .replaceAll(/<footer[^>]*>[\s\S]*?<\/footer>/gi, "")
            .replaceAll(/<header[^>]*>[\s\S]*?<\/header>/gi, "")
            .replaceAll(/<[^<>]*>/g, " ")
            .replaceAll(/\s+/g, " ")
            .trim();

        const titleMatch = html.match(TITLE_TAG_RE);
        const title = titleMatch?.[1]?.trim() || "";

        return {
            content: truncateText(textContent, 8000),
            title,
        };
    } catch {
        return null;
    }
};

/**
 * A clear, descriptive title for the research report.
 */
const deepResearchTool = createTool<
    {
        depth?: "standard" | "comprehensive";
        topic: string;
    },
    {
        documentId: string;
        queriesExecuted: number;
        sourcesCount: number;
        summary: string;
        title: string;
    },
    ToolContext
>({
    description: `Conduct comprehensive multi-step research on a topic. This tool:
1. Generates multiple targeted search queries
2. Searches the web in parallel
3. Retrieves and analyzes full source content
4. Synthesizes findings into a structured research report
5. Saves the report as a document artifact

Use this for questions requiring thorough investigation, multiple perspectives, or synthesis of many sources.
NOT for simple factual lookups - use webSearch for those.`,
    execute: async (context, input) => {
        const { depth = "standard", topic } = input;

        if (!context.userId || !context.threadId || !context.messageId) {
            throw new Error("Deep research requires userId, threadId, and messageId in tool context");
        }

        if (!TAVILY_API_KEY && !EXA_API_KEY) {
            throw new Error("Deep research requires at least one search API key (TAVILY_API_KEY or EXA_API_KEY)");
        }

        // Override depth based on researchDepth from tool context
        const effectiveDepth = context.researchDepth === "thorough" ? "comprehensive" : depth;
        const isComprehensive = effectiveDepth === "comprehensive";

        // Scale queries and results based on research depth
        const depthScale = {
            balanced: { maxQueries: isComprehensive ? 8 : 5, resultsPerQuery: isComprehensive ? 8 : 5 },
            speed: { maxQueries: 3, resultsPerQuery: 3 },
            thorough: { maxQueries: 10, resultsPerQuery: 8 },
        };
        const scale = depthScale[context.researchDepth || "balanced"];
        const { maxQueries, resultsPerQuery } = scale;

        toolsLogger.debug(`[DeepResearch] Starting ${depth} research on: "${topic}"`);

        // Step 1: Generate research plan with targeted search queries
        toolsLogger.debug(`[DeepResearch] Step 1: Generating research plan...`);

        let searchQueries: string[];

        try {
            if (!context.agent) {
                throw new Error("Agent not initialized");
            }

            const planResult = await generateText({
                model: context.agent.options.languageModel as LanguageModel,
                output: Output.object({
                    schema: z.object({
                        reportTitle: z.string().meta({ description: "A clear, descriptive title for the research report" }),
                        searchQueries: z
                            .array(z.string())
                            .min(3)
                            .max(maxQueries)
                            .meta({ description: "Targeted search queries to investigate different aspects of the topic" }),
                    }),
                }),
                prompt: `You are a research assistant. Generate ${maxQueries} diverse search queries to thoroughly investigate this topic:

"${topic}"

Requirements:
- Each query should explore a different angle or aspect
- Include queries for background context, recent developments, expert opinions, and data/statistics
- Make queries specific and targeted for web search
- Include date ranges or recent years for time-sensitive topics
- Generate a clear title for the research report`,
            });

            if (!planResult.output?.searchQueries) {
                throw new Error("Plan result missing searchQueries");
            }

            searchQueries = planResult.output.searchQueries;
            toolsLogger.debug(`[DeepResearch] Generated ${searchQueries.length} search queries`);
        } catch (error) {
            toolsLogger.error(`[DeepResearch] Failed to generate research plan:`, error);
            // Fallback: use the topic as a direct search query with variations
            searchQueries = [topic, `${topic} overview analysis`, `${topic} latest developments ${new Date().getFullYear()}`];
        }

        // Step 2: Execute parallel web searches
        toolsLogger.debug(`[DeepResearch] Step 2: Executing ${searchQueries.length} parallel searches...`);

        const searchPromises = searchQueries.map((query) =>
            withRetry(() => researchSearch(query, resultsPerQuery), { maxRetries: 1 }).catch(() => [] as WebSearchResult[]),
        );

        const searchResults = await Promise.all(searchPromises);

        // Collect and deduplicate all results
        const allResults: (WebSearchResult & { query: string })[] = [];

        for (const [i, results] of searchResults.entries()) {
            const query = searchQueries[i];

            if (results && query) {
                for (const result of results) {
                    allResults.push({ ...result, query });
                }
            }
        }

        const deduplicatedResults = deduplicateByDomainAndUrl(allResults, 3);

        toolsLogger.debug(`[DeepResearch] Found ${allResults.length} results, ${deduplicatedResults.length} after dedup`);

        // Step 3: Retrieve full content from top sources
        toolsLogger.debug(`[DeepResearch] Step 3: Retrieving content from top sources...`);

        const topSources = deduplicatedResults.slice(0, isComprehensive ? 15 : 8);
        const contentPromises = topSources.map((source) => retrieveContent(source.url).catch(() => null));

        const retrievedContents = await Promise.all(contentPromises);

        // Build source materials for synthesis
        const sourceMaterials: string[] = [];
        const citedSources: { title: string; url: string }[] = [];

        for (const [i, source] of topSources.entries()) {
            if (!source) {
                continue;
            }

            const retrieved = retrievedContents[i];
            const content = retrieved?.content || source.content;

            if (content && content.length > 50) {
                const sourceIndex = citedSources.length + 1;

                citedSources.push({ title: source.title || retrieved?.title || source.url, url: source.url });
                sourceMaterials.push(`[Source ${sourceIndex}] ${source.title}\nURL: ${source.url}\n${truncateText(content, 4000)}`);
            }
        }

        toolsLogger.debug(`[DeepResearch] Compiled ${sourceMaterials.length} source materials`);

        if (sourceMaterials.length === 0) {
            // If no sources were found, create a minimal report
            const minimalReport = `# Research Report: ${topic}\n\nNo relevant sources could be found for this topic. Try refining your research question or using different keywords.`;

            const document = await context.runMutation(internal.agent.documents.createDocument, {
                content: minimalReport,
                kind: "text",
                messageId: context.messageId,
                threadId: context.threadId as Id<"threads">,
                title: `Research: ${topic.slice(0, 100)}`,
                userId: context.userId,
            });

            return {
                documentId: document._id,
                queriesExecuted: searchQueries.length,
                sourcesCount: 0,
                summary: "No relevant sources were found for this topic.",
                title: `Research: ${topic.slice(0, 100)}`,
            };
        }

        // Step 4: Synthesize findings into a research report
        toolsLogger.debug(`[DeepResearch] Step 4: Synthesizing research report...`);

        const synthesisPrompt = `You are a senior research analyst. Synthesize the following source materials into a comprehensive research report on:

"${topic}"

SOURCE MATERIALS:
${sourceMaterials.join("\n\n---\n\n")}

INSTRUCTIONS:
- Write a thorough, well-structured research report in Markdown format
- Start with an executive summary (2-3 paragraphs)
- Organize findings into logical sections with clear headings
- Include specific data points, statistics, and quotes from sources
- Note any conflicting information or areas of debate
- Add a "Key Findings" section with bullet points
- End with a "Sources" section listing all cited sources as numbered references
- Use [Source N] citations throughout the report
- Be objective and present multiple perspectives
- Write in an accessible but professional tone

SOURCES LIST (for the Sources section):
${citedSources.map((s, i) => `[${i + 1}] ${s.title} - ${s.url}`).join("\n")}`;

        let reportContent: string;

        try {
            if (!context.agent) {
                throw new Error("Agent not initialized");
            }

            const synthesisResult = await generateText({
                model: context.agent.options.languageModel as LanguageModel,
                prompt: synthesisPrompt,
            });

            reportContent = synthesisResult.text;
        } catch (error) {
            toolsLogger.error(`[DeepResearch] Synthesis failed:`, error);
            // Fallback: compile a basic report from source snippets
            reportContent = `# Research Report: ${topic}\n\n## Sources Found\n\n${citedSources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n")}\n\n## Summary\n\nResearch compilation was interrupted. Please review the sources above for more information.`;
        }

        // Step 5: Save report as a canvas document
        toolsLogger.debug(`[DeepResearch] Step 5: Saving report as document...`);

        const reportTitle = `Research: ${topic.slice(0, 150)}`;

        const document = await context.runMutation(internal.agent.documents.createDocument, {
            content: reportContent,
            kind: "text",
            messageId: context.messageId,
            threadId: context.threadId as Id<"threads">,
            title: reportTitle,
            userId: context.userId,
        });

        // Generate a brief summary for the chat response
        const summaryLines = reportContent.split("\n").filter((l) => l.trim().length > 0);
        const summary = `${summaryLines.slice(0, 5).join(" ").slice(0, 300)}...`;

        toolsLogger.debug(`[DeepResearch] Complete. Report saved as document ${document._id}`);

        return {
            documentId: document._id,
            queriesExecuted: searchQueries.length,
            sourcesCount: citedSources.length,
            summary,
            title: reportTitle,
        };
    },
    inputSchema: z
        .object({
            depth: z
                .enum(["standard", "comprehensive"])
                .optional()
                .default("standard")
                .meta({ description: "Research depth: 'standard' (3-5 queries, ~10 sources) or 'comprehensive' (5-8 queries, ~20 sources)" }),
            topic: z.string().min(5).max(1000).meta({ description: "The research topic or question to investigate" }),
        })
        .strict(),
    title: "Deep Research",
});

export default deepResearchTool;
