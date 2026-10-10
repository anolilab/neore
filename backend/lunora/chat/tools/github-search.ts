/**
 * GitHub Search Tool
 * Search GitHub repositories, code, issues, and discussions
 */
import z from "zod/v4";

import type { ToolCtx as ToolContext } from "../../agent/client";
import { createTool } from "../../agent/client";
import { GITHUB_TOKEN } from "../../env";
import toonEncodeOutput from "./toon-encode";
import { fetchWithTimeout, truncateText, withRetry } from "./utilities";

export interface GitHubRepoInfo {
    createdAt: string;
    description: string | null;
    forksCount: number;
    fullName: string;
    htmlUrl: string;
    id: number;
    language: string | null;
    license?: {
        name: string;
        spdxId: string;
    };
    name: string;
    openIssuesCount: number;
    owner: {
        avatarUrl: string;
        login: string;
        type: string;
    };
    pushedAt: string;
    stargazersCount: number;
    topics: string[];
    updatedAt: string;
    url: string;
}

export interface GitHubCodeResult {
    htmlUrl: string;
    name: string;
    path: string;
    repository: {
        fullName: string;
        htmlUrl: string;
        id: number;
        name: string;
    };
    sha: string;
    textMatches?: {
        fragment: string;
    }[];
    url: string;
}

export interface GitHubIssue {
    body: string | null;
    comments: number;
    createdAt: string;
    htmlUrl: string;
    id: number;
    labels: {
        color: string;
        name: string;
    }[];
    number: number;
    repository?: {
        fullName: string;
    };
    state: string;
    title: string;
    updatedAt: string;
    user: {
        avatarUrl: string;
        login: string;
    };
}

interface GitHubApiRepoResponse {
    incomplete_results: boolean;
    items: {
        created_at: string;
        description: string | null;
        forks_count: number;
        full_name: string;
        html_url: string;
        id: number;
        language: string | null;
        license?: {
            name: string;
            spdx_id: string;
        };
        name: string;
        open_issues_count: number;
        owner: {
            avatar_url: string;
            login: string;
            type: string;
        };
        pushed_at: string;
        stargazers_count: number;
        topics: string[];
        updated_at: string;
        url: string;
    }[];
    total_count: number;
}

interface GitHubApiCodeResponse {
    incomplete_results: boolean;
    items: {
        html_url: string;
        name: string;
        path: string;
        repository: {
            full_name: string;
            html_url: string;
            id: number;
            name: string;
        };
        sha: string;
        text_matches?: {
            fragment: string;
        }[];
        url: string;
    }[];
    total_count: number;
}

interface GitHubApiIssueResponse {
    incomplete_results: boolean;
    items: {
        body: string | null;
        comments: number;
        created_at: string;
        html_url: string;
        id: number;
        labels: {
            color: string;
            name: string;
        }[];
        number: number;
        repository_url?: string;
        state: string;
        title: string;
        updated_at: string;
        user: {
            avatar_url: string;
            login: string;
        };
    }[];
    total_count: number;
}

const GITHUB_API_URL = "https://api.github.com";

/**
 * Build GitHub API headers.
 */
const getGitHubHeaders = (): HeadersInit => {
    const headers: HeadersInit = {
        Accept: "application/vnd.github.v3+json",
        "User-Agent": "Neore-Chat-App",
    };

    if (GITHUB_TOKEN) {
        headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
    }

    return headers;
};

/**
 * Search GitHub repositories.
 */
const searchRepositories = async (query: string, sort: string, order: string, perPage: number): Promise<GitHubRepoInfo[]> => {
    const params = new URLSearchParams({
        order,
        per_page: perPage.toString(),
        q: query,
        sort,
    });

    const response = await fetchWithTimeout(`${GITHUB_API_URL}/search/repositories?${params.toString()}`, {
        headers: getGitHubHeaders(),
    });

    if (!response.ok) {
        await response.body?.cancel();

        if (response.status === 403) {
            throw new Error("GitHub API rate limit exceeded. Try again later or provide a GITHUB_TOKEN.");
        }

        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as GitHubApiRepoResponse;

    return data.items.map((item) => {
        return {
            createdAt: item.created_at,
            description: item.description,
            forksCount: item.forks_count,
            fullName: item.full_name,
            htmlUrl: item.html_url,
            id: item.id,
            language: item.language,
            license: item.license
                ? {
                      name: item.license.name,
                      spdxId: item.license.spdx_id,
                  }
                : undefined,
            name: item.name,
            openIssuesCount: item.open_issues_count,
            owner: {
                avatarUrl: item.owner.avatar_url,
                login: item.owner.login,
                type: item.owner.type,
            },
            pushedAt: item.pushed_at,
            stargazersCount: item.stargazers_count,
            topics: item.topics,
            updatedAt: item.updated_at,
            url: item.url,
        };
    });
};

/**
 * Search GitHub code.
 */
const searchCode = async (query: string, perPage: number): Promise<GitHubCodeResult[]> => {
    const params = new URLSearchParams({
        per_page: perPage.toString(),
        q: query,
    });

    const response = await fetchWithTimeout(`${GITHUB_API_URL}/search/code?${params.toString()}`, {
        headers: {
            ...getGitHubHeaders(),
            Accept: "application/vnd.github.v3.text-match+json",
        },
    });

    if (!response.ok) {
        await response.body?.cancel();

        if (response.status === 403) {
            throw new Error("GitHub API rate limit exceeded. Try again later or provide a GITHUB_TOKEN.");
        }

        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as GitHubApiCodeResponse;

    return data.items.map((item) => {
        return {
            htmlUrl: item.html_url,
            name: item.name,
            path: item.path,
            repository: {
                fullName: item.repository.full_name,
                htmlUrl: item.repository.html_url,
                id: item.repository.id,
                name: item.repository.name,
            },
            sha: item.sha,
            textMatches: item.text_matches?.map((match) => {
                return {
                    fragment: match.fragment,
                };
            }),
            url: item.url,
        };
    });
};

/**
 * Search GitHub issues and pull requests.
 */
const searchIssues = async (query: string, sort: string, order: string, perPage: number): Promise<GitHubIssue[]> => {
    const params = new URLSearchParams({
        order,
        per_page: perPage.toString(),
        q: query,
        sort,
    });

    const response = await fetchWithTimeout(`${GITHUB_API_URL}/search/issues?${params.toString()}`, {
        headers: getGitHubHeaders(),
    });

    if (!response.ok) {
        await response.body?.cancel();

        if (response.status === 403) {
            throw new Error("GitHub API rate limit exceeded. Try again later or provide a GITHUB_TOKEN.");
        }

        throw new Error(`GitHub API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as GitHubApiIssueResponse;

    return data.items.map((item) => {
        return {
            body: item.body ? truncateText(item.body, 500) : null,
            comments: item.comments,
            createdAt: item.created_at,
            htmlUrl: item.html_url,
            id: item.id,
            labels: item.labels.map((label) => {
                return {
                    color: label.color,
                    name: label.name,
                };
            }),
            number: item.number,
            repository: item.repository_url
                ? {
                      fullName: item.repository_url.replace("https://api.github.com/repos/", ""),
                  }
                : undefined,
            state: item.state,
            title: item.title,
            updatedAt: item.updated_at,
            user: {
                avatarUrl: item.user.avatar_url,
                login: item.user.login,
            },
        };
    });
};

/**
 * GitHub Search Tool
 */
const githubSearchTool = createTool<
    {
        language?: string;
        maxResults?: number;
        order?: "asc" | "desc";
        query: string;
        searchType?: "repositories" | "code" | "issues";
        sort?: string;
    },
    {
        code?: GitHubCodeResult[];
        error?: string;
        issues?: GitHubIssue[];
        repositories?: GitHubRepoInfo[];
        searchType: string;
        success: boolean;
        totalResults?: number;
    },
    ToolContext
>({
    description: `Search GitHub repositories, code, and issues/pull requests.

Search types:
- repositories: Find repos by name, description, topics, language
- code: Search code within repositories (requires specific query)
- issues: Search issues and pull requests

Query modifiers:
- language:javascript - Filter by programming language
- user:username - Search within user's repos
- org:orgname - Search within organization
- stars:>1000 - Filter by star count
- topic:react - Filter by topic
- is:issue or is:pr - Filter issues vs PRs`,
    execute: async (_context, input) => {
        const { language, maxResults = 10, order = "desc", query, searchType = "repositories", sort } = input;

        // Build the full query with language filter
        let fullQuery = query;

        if (language) {
            fullQuery += ` language:${language}`;
        }

        try {
            if (searchType === "repositories") {
                const sortField = sort || "stars";
                const repositories = await withRetry(() => searchRepositories(fullQuery, sortField, order, maxResults), { maxRetries: 2 });

                return {
                    repositories,
                    searchType,
                    success: true,
                    totalResults: repositories.length,
                };
            }

            if (searchType === "code") {
                const code = await withRetry(() => searchCode(fullQuery, maxResults), { maxRetries: 2 });

                return {
                    code,
                    searchType,
                    success: true,
                    totalResults: code.length,
                };
            }

            const sortField = sort || "created";
            const issues = await withRetry(() => searchIssues(fullQuery, sortField, order, maxResults), { maxRetries: 2 });

            return {
                issues,
                searchType,
                success: true,
                totalResults: issues.length,
            };
        } catch (error) {
            return {
                error: error instanceof Error ? error.message : "GitHub search failed",
                searchType,
                success: false,
            };
        }
    },
    inputSchema: z
        .object({
            language: z.string().optional().meta({ description: "Filter by programming language (e.g., javascript, python, rust)" }),
            maxResults: z.number().min(1).max(30).optional().default(10).meta({ description: "Maximum results to return" }),
            order: z.enum(["asc", "desc"]).optional().default("desc").meta({ description: "Sort order" }),
            query: z.string().min(1).max(256).meta({ description: "Search query (supports GitHub search syntax)" }),
            searchType: z
                .enum(["repositories", "code", "issues"])
                .optional()
                .default("repositories")
                .meta({ description: "Type of search: repositories, code, or issues" }),
            sort: z.string().optional().meta({ description: "Sort field (repositories: stars, forks, updated; issues: created, updated, comments)" }),
        })
        .strict(),
    title: "GitHub Search",
    toModelOutput: (_context, { output }) => toonEncodeOutput(output),
});

export default githubSearchTool;
