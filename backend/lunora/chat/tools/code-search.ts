/**
 * Code Search Tool
 * Search for programming documentation, code snippets, and technical information
 * Uses Stack Exchange API for Stack Overflow search
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { assertOk } from "../../lib/fetch-timeout";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, truncateText, withRetry } from "./utilities";

export interface StackOverflowQuestion {
    answerCount: number;
    bodyExcerpt?: string;
    createdAt: string;
    isAnswered: boolean;
    lastActivityAt: string;
    link: string;
    owner: {
        displayName: string;
        profileUrl?: string;
        reputation: number;
    };
    questionId: number;
    score: number;
    tags: string[];
    title: string;
    viewCount: number;
}

export interface StackOverflowAnswer {
    answerId: number;
    bodyExcerpt?: string;
    createdAt: string;
    isAccepted: boolean;
    owner: {
        displayName: string;
        reputation: number;
    };
    questionId: number;
    score: number;
}

// Stack Exchange API response types
interface StackExchangeApiQuestion {
    answer_count: number;
    body_markdown?: string;
    creation_date: number;
    is_answered: boolean;
    last_activity_date: number;
    link: string;
    owner: {
        display_name: string;
        link?: string;
        reputation: number;
    };
    question_id: number;
    score: number;
    tags: string[];
    title: string;
    view_count: number;
}

interface StackExchangeApiAnswer {
    answer_id: number;
    body_markdown?: string;
    creation_date: number;
    is_accepted: boolean;
    owner: {
        display_name: string;
        reputation: number;
    };
    question_id: number;
    score: number;
}

interface StackExchangeSearchResponse {
    has_more: boolean;
    items: StackExchangeApiQuestion[];
    quota_max: number;
    quota_remaining: number;
}

interface StackExchangeAnswersResponse {
    has_more: boolean;
    items: StackExchangeApiAnswer[];
    quota_max: number;
    quota_remaining: number;
}

const STACK_EXCHANGE_API_URL = "https://api.stackexchange.com/2.3";

/**
 * Search Stack Overflow questions.
 */
const searchStackOverflow = async (query: string, tags: string[], sort: string, pageSize: number): Promise<StackOverflowQuestion[]> => {
    const params = new URLSearchParams({
        filter: "withbody", // Include body in response
        order: "desc",
        pagesize: pageSize.toString(),
        site: "stackoverflow",
        sort,
    });

    // Use intitle search for better results
    params.set("intitle", query);

    // Add tags if provided
    if (tags.length > 0) {
        params.set("tagged", tags.join(";"));
    }

    const response = await fetchWithTimeout(`${STACK_EXCHANGE_API_URL}/search/advanced?${params.toString()}`);

    await assertOk(response, "Stack Exchange API error");

    const data = (await response.json()) as StackExchangeSearchResponse;

    return data.items.map((item) => {
        return {
            answerCount: item.answer_count,
            bodyExcerpt: item.body_markdown ? truncateText(item.body_markdown, 500) : undefined,
            createdAt: new Date(item.creation_date * 1000).toISOString(),
            isAnswered: item.is_answered,
            lastActivityAt: new Date(item.last_activity_date * 1000).toISOString(),
            link: item.link,
            owner: {
                displayName: item.owner.display_name,
                profileUrl: item.owner.link,
                reputation: item.owner.reputation,
            },
            questionId: item.question_id,
            score: item.score,
            tags: item.tags,
            title: item.title,
            viewCount: item.view_count,
        };
    });
};

/**
 * Get answers for a specific question.
 */
const getQuestionAnswers = async (questionId: number, pageSize: number): Promise<StackOverflowAnswer[]> => {
    const params = new URLSearchParams({
        filter: "withbody",
        order: "desc",
        pagesize: pageSize.toString(),
        site: "stackoverflow",
        sort: "votes",
    });

    const response = await fetchWithTimeout(`${STACK_EXCHANGE_API_URL}/questions/${questionId}/answers?${params.toString()}`);

    await assertOk(response, "Stack Exchange API error");

    const data = (await response.json()) as StackExchangeAnswersResponse;

    return data.items.map((item) => {
        return {
            answerId: item.answer_id,
            bodyExcerpt: item.body_markdown ? truncateText(item.body_markdown, 1000) : undefined,
            createdAt: new Date(item.creation_date * 1000).toISOString(),
            isAccepted: item.is_accepted,
            owner: {
                displayName: item.owner.display_name,
                reputation: item.owner.reputation,
            },
            questionId: item.question_id,
            score: item.score,
        };
    });
};

/**
 * Search questions with specific tags only.
 */
const searchByTags = async (tags: string[], sort: string, pageSize: number): Promise<StackOverflowQuestion[]> => {
    const params = new URLSearchParams({
        filter: "withbody",
        order: "desc",
        pagesize: pageSize.toString(),
        site: "stackoverflow",
        sort,
        tagged: tags.join(";"),
    });

    const response = await fetchWithTimeout(`${STACK_EXCHANGE_API_URL}/questions?${params.toString()}`);

    await assertOk(response, "Stack Exchange API error");

    const data = (await response.json()) as StackExchangeSearchResponse;

    return data.items.map((item) => {
        return {
            answerCount: item.answer_count,
            bodyExcerpt: item.body_markdown ? truncateText(item.body_markdown, 500) : undefined,
            createdAt: new Date(item.creation_date * 1000).toISOString(),
            isAnswered: item.is_answered,
            lastActivityAt: new Date(item.last_activity_date * 1000).toISOString(),
            link: item.link,
            owner: {
                displayName: item.owner.display_name,
                profileUrl: item.owner.link,
                reputation: item.owner.reputation,
            },
            questionId: item.question_id,
            score: item.score,
            tags: item.tags,
            title: item.title,
            viewCount: item.view_count,
        };
    });
};

/**
 * Maximum results to return.
 */
const codeSearchTool = createTool<
    {
        maxResults?: number;
        query: string;
        questionId?: number;
        searchType?: "questions" | "answers" | "tagged";
        sort?: "relevance" | "votes" | "activity" | "creation";
        tags?: string[];
    },
    {
        answers?: StackOverflowAnswer[];
        error?: string;
        questions?: StackOverflowQuestion[];
        searchType: string;
        success: boolean;
        totalResults?: number;
    },
    ToolContext
>({
    description: `Search Stack Overflow for programming questions, answers, and code snippets.

Search types:
- questions: Search for questions by title/content
- answers: Get answers for a specific question (requires questionId)
- tagged: Browse questions by programming language/technology tags

Common tags: javascript, python, typescript, react, node.js, java, c#, php, html, css, sql, git, docker, kubernetes, aws, etc.

Sort options:
- relevance: Most relevant to search query
- votes: Highest voted questions/answers
- activity: Recently active
- creation: Newest first

Returns questions with title, score, answer count, tags, and body excerpt.`,
    execute: async (_context, input) => {
        const { maxResults = 10, query, questionId, searchType = "questions", sort = "relevance", tags = [] } = input;

        try {
            if (searchType === "answers") {
                if (!questionId) {
                    return {
                        error: "questionId is required when searchType is 'answers'",
                        searchType,
                        success: false,
                    };
                }

                const answers = await withRetry(() => getQuestionAnswers(questionId, maxResults), { maxRetries: 2 });

                return {
                    answers,
                    searchType,
                    success: true,
                    totalResults: answers.length,
                };
            }

            if (searchType === "tagged" && tags.length > 0) {
                const questions = await withRetry(() => searchByTags(tags, sort, maxResults), { maxRetries: 2 });

                return {
                    questions,
                    searchType,
                    success: true,
                    totalResults: questions.length,
                };
            }

            const questions = await withRetry(() => searchStackOverflow(query, tags, sort, maxResults), {
                maxRetries: 2,
            });

            return {
                questions,
                searchType,
                success: true,
                totalResults: questions.length,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "Code search failed",
                searchType,
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            maxResults: z.number().min(1).max(30).optional().default(10).meta({ description: "Maximum results to return" }),
            query: z.string().min(1).max(256).meta({ description: "Search query for programming questions" }),
            questionId: z.number().optional().meta({ description: "Question ID (required when searchType is 'answers')" }),
            searchType: z
                .enum(["questions", "answers", "tagged"])
                .optional()
                .default("questions")
                .meta({ description: "Type of search: questions, answers (for specific question), or tagged (browse by tags)" }),
            sort: z.enum(["relevance", "votes", "activity", "creation"]).optional().default("relevance").meta({ description: "Sort order for results" }),
            tags: z.array(z.string()).optional().meta({ description: "Programming language or technology tags to filter by (e.g., ['javascript', 'react'])" }),
        })
        .strict(),
    title: "Code Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default codeSearchTool;
