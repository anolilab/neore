/**
 * The provider request each web search call sends, read off a fake fetch. The
 * user's blocklist must reach Tavily and Exa as their exclude lists (merged with
 * the model's, deduplicated, capped to the provider's limit), and the post-filter
 * must still drop a blocked result a provider returns anyway.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../env", () => {
    return { EXA_API_KEY: "exa-key", PARALLEL_API_KEY: "par-key", TAVILY_API_KEY: "tav-key" };
});
vi.mock("../../_generated/internal", () => {
    return {
        internal: { auth: { functions: { getDecryptedToolKeysQuery: "keys", getSearchDomainBlocklistQuery: "blocklist" } } },
    };
});
vi.mock("../../agent/client", () => {
    return { createTool: (definition: unknown) => definition };
});

interface SearchTool {
    execute: (context: unknown, input: unknown) => Promise<{ results: { results: { url: string }[] }[] }>;
}

const { default: webSearchTool } = await import("./web-search");
const tool = webSearchTool as unknown as SearchTool;

const sent: { body: Record<string, unknown>; url: string }[] = [];

const stubProvider = (results: unknown) => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, url });

        return Response.json(results, { headers: { "content-type": "application/json" } });
    });
};

const run = (blocklist: string[], input: Record<string, unknown>) => {
    const context = {
        researchDepth: "speed",
        runQuery: async (reference: unknown) => (reference === "blocklist" ? blocklist : {}),
        userId: "user-1",
    };

    return tool.execute(context, { queries: ["q"], ...input });
};

afterEach(() => {
    vi.unstubAllGlobals();
    sent.length = 0;
});

describe("web search provider requests", () => {
    it("Exa gets the merged blocklist as camelCase excludeDomains, and the post-filter drops a blocked result", async () => {
        stubProvider({
            results: [
                { text: "a", title: "a", url: "https://docs.example.com/x" },
                { text: "b", title: "b", url: "https://ok.org/y" },
            ],
        });

        const output = await run(["example.com", "ads.net"], { excludeDomains: ["spam.io", "example.com"], maxResults: 7, provider: "exa" });

        expect(sent).toStrictEqual([
            {
                body: {
                    contents: { text: { maxCharacters: 2000 } },
                    excludeDomains: ["spam.io", "example.com", "ads.net"],
                    numResults: 7,
                    query: "q",
                    use_autoprompt: true,
                },
                url: "https://api.exa.ai/search",
            },
        ]);
        expect(output.results[0]?.results.map((r) => r.url)).toStrictEqual(["https://ok.org/y"]);
    });

    it("Exa sends no domain keys when there is no blocklist and no model excludes", async () => {
        stubProvider({ results: [] });

        await run([], { maxResults: 7, provider: "exa" });

        expect(sent[0]?.body).toStrictEqual({ contents: { text: { maxCharacters: 2000 } }, numResults: 7, query: "q", use_autoprompt: true });
    });

    it("Exa sends excludeDomains only when there is no include list, since the docs do not say the two combine", async () => {
        stubProvider({ results: [] });

        await run(["example.com"], { includeDomains: ["docs.example.com", "python.org"], maxResults: 7, provider: "exa" });

        expect(sent[0]?.body).toStrictEqual({
            contents: { text: { maxCharacters: 2000 } },
            includeDomains: ["python.org"],
            numResults: 7,
            query: "q",
            use_autoprompt: true,
        });
    });

    it("Exa with both include and exclude lists still drops results from a model-excluded domain", async () => {
        stubProvider({
            results: [
                { text: "a", title: "a", url: "https://spam.io/x" },
                { text: "b", title: "b", url: "https://python.org/y" },
                { text: "c", title: "c", url: "https://blog.spam.io/z" },
            ],
        });

        const output = await run([], { excludeDomains: ["https://Spam.io/path"], includeDomains: ["python.org", "spam.io"], maxResults: 7, provider: "exa" });

        expect(sent[0]?.body).toMatchObject({ includeDomains: ["python.org", "spam.io"] });
        expect(output.results[0]?.results.map((r) => r.url)).toStrictEqual(["https://python.org/y"]);
    });

    it("Tavily gets the merged blocklist as exclude_domains", async () => {
        stubProvider({ results: [{ content: "a", title: "a", url: "https://ok.org/y" }] });

        await run(["example.com", "ads.net"], { excludeDomains: ["spam.io", "example.com"], maxResults: 7, provider: "tavily" });

        expect(sent[0]?.body).toStrictEqual({
            api_key: "tav-key",
            exclude_domains: ["spam.io", "example.com", "ads.net"],
            include_answer: false,
            include_images: true,
            max_results: 7,
            query: "q",
            search_depth: "advanced",
            topic: "general",
        });
    });

    it("Tavily caps exclude_domains at its documented 150", async () => {
        stubProvider({ results: [] });

        const modelExcludes = Array.from({ length: 60 }, (_, i) => `model${i}.net`);
        const blocklist = Array.from({ length: 100 }, (_, i) => `blocked${i}.org`);

        await run(blocklist, { excludeDomains: modelExcludes, maxResults: 7, provider: "tavily" });

        const excludes = sent[0]?.body.exclude_domains as string[];

        expect(excludes).toHaveLength(150);
        expect(excludes).toStrictEqual([...modelExcludes, ...blocklist].slice(0, 150));
    });
});
