/**
 * Knowledge Base Auto-Summarization
 *
 * Generates and maintains summaries for knowledge base files.
 * Summaries are used for:
 * - Quick file overview in the UI
 * - Better search relevance (summary-based matching)
 * - Agent context injection (concise document descriptions)
 *
 * Supports two modes:
 * 1. Single-file summary: Generated during ingestion (already in ingest.ts)
 * 2. Collection summary: Aggregates all KB files into a topic overview
 */
import { generateText, Output } from "ai";
import { v } from "lunorash/server";
import z from "zod/v4";

import { internal } from "../_generated/internal";
import { internalAction } from "../_generated/server";
import { gatewayFetch } from "../lib/services";

("use node");

export const resummarizeFile = internalAction
    .input({
        knowledgeFileId: v.id("knowledgeFiles"),
    })
    .action(async ({ args: { knowledgeFileId }, ctx }) => {
        const file = await ctx.runQuery(internal.knowledge.functions.getFile, {
            fileId: knowledgeFileId,
        });

        if (!file || file.status !== "indexed") {
            return { error: "File not found or not indexed", success: false };
        }

        // Gather chunks for this file (first ~10 for context)
        const chunks = await ctx.runQuery(internal.knowledge.functions.getFileChunks, {
            fileId: knowledgeFileId,
            limit: 10,
        });

        if (chunks.length === 0) {
            return { error: "No chunks found for file", success: false };
        }

        const contentSample = chunks.map((c: any) => c.content).join("\n\n---\n\n");

        try {
            const { getUtilityModel } = await import("../lib/utility-model");
            const model = await getUtilityModel(gatewayFetch(ctx));

            const result = await generateText({
                model,
                output: Output.object({
                    schema: z.object({
                        documentType: z
                            .enum(["technical_doc", "article", "report", "guide", "reference", "code", "data", "correspondence", "other"])
                            .meta({ description: "Type of document" }),
                        summary: z.string().meta({ description: "2-3 sentence summary of the document" }),
                        topics: z.array(z.string()).meta({ description: "Key topics covered (3-7 items)" }),
                    }),
                }),
                prompt: `Analyze this document and provide a structured summary.

Document title: ${file.name}
Document type: ${file.mimeType}
Content sample (first ~10 chunks):

${contentSample.slice(0, 6000)}`,
            });

            if (result.output) {
                await ctx.runMutation(internal.knowledge.functions.updateFileStatus, {
                    fileId: knowledgeFileId,
                    status: "indexed",
                    summary: result.output.summary,
                });

                ctx.log.event("knowledge.resummarize_file", {
                    documentType: result.output.documentType,
                    inputTokens: result.usage.inputTokens,
                    outputTokens: result.usage.outputTokens,
                    topicCount: result.output.topics.length,
                });

                return {
                    documentType: result.output.documentType,
                    success: true,
                    summary: result.output.summary,
                    topics: result.output.topics,
                };
            }

            return { error: "No output from model", success: false };
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);

            return { error: errorMessage, success: false };
        }
    });

export const summarizeCollection = internalAction
    .input({
        userId: v.string(),
    })
    .action(async ({ args: { userId }, ctx }) => {
        // Get all indexed files
        const fileIds = await ctx.runQuery(internal.knowledge.functions.getIndexedFileIds, {
            userId,
        });

        if (fileIds.length === 0) {
            return { fileCount: 0, summary: "No indexed knowledge base files." };
        }

        // Gather file metadata
        const fileSummaries: string[] = [];

        for (const fileId of fileIds.slice(0, 50)) {
            // Cap at 50 files
            const file = await ctx.runQuery(internal.knowledge.functions.getFile, {
                fileId,
            });

            if (file) {
                fileSummaries.push(`- ${file.name} (${file.mimeType}, ${file.chunkCount ?? 0} chunks)${file.summary ? `: ${file.summary}` : ""}`);
            }
        }

        try {
            const { getUtilityModel } = await import("../lib/utility-model");
            const model = await getUtilityModel(gatewayFetch(ctx), { userId });

            const result = await generateText({
                model,
                output: Output.object({
                    schema: z.object({
                        mainTopics: z.array(z.string()).meta({ description: "Main topics covered across all files" }),
                        overview: z.string().meta({ description: "3-5 sentence overview of the knowledge base" }),
                        totalFiles: z.number(),
                    }),
                }),
                prompt: `Summarize this user's knowledge base collection. What topics and domains does it cover?

Files (${fileIds.length} total):
${fileSummaries.join("\n")}`,
            });

            ctx.log.event("knowledge.summarize_collection", {
                fileCount: fileIds.length,
                inputTokens: result.usage.inputTokens,
                outputTokens: result.usage.outputTokens,
            });

            return {
                fileCount: fileIds.length,
                summary: result.output?.overview ?? "Could not generate overview.",
                topics: result.output?.mainTopics ?? [],
            };
        } catch {
            return {
                fileCount: fileIds.length,
                summary: `Knowledge base contains ${fileIds.length} indexed files.`,
            };
        }
    });
