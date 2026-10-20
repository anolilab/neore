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
const sentHeaders: Record<string, string>[] = [];

const stubProvider = (results: unknown) => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, url });
        sentHeaders.push(init.headers as Record<string, string>);

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
    sentHeaders.length = 0;
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

    // https://docs.parallel.ai/api-reference/search-beta/search: the request body is closed, so a stray key is a 422.
    it("Parallel sends exactly the documented body, with the key in x-api-key", async () => {
        stubProvider({ results: [] });

        await run([], { maxResults: 7, provider: "parallel" });

        expect(sent).toStrictEqual([{ body: { advanced_settings: { max_results: 7 }, search_queries: ["q"] }, url: "https://api.parallel.ai/v1/search" }]);
        expect(sentHeaders[0]).toStrictEqual({ "Content-Type": "application/json", "x-api-key": "par-key" });
    });

    it("Parallel gets the merged blocklist as source_policy.exclude_domains", async () => {
        stubProvider({ results: [] });

        await run(["example.com", "ads.net"], { excludeDomains: ["spam.io", "example.com"], maxResults: 7, provider: "parallel" });

        expect(sent[0]?.body).toStrictEqual({
            advanced_settings: { max_results: 7, source_policy: { exclude_domains: ["spam.io", "example.com", "ads.net"] } },
            search_queries: ["q"],
        });
    });

    it("Parallel sends only the include list when there is one, since it makes the exclude list moot", async () => {
        stubProvider({ results: [] });

        await run(["example.com"], { includeDomains: ["docs.example.com", "python.org"], maxResults: 7, provider: "parallel" });

        expect(sent[0]?.body.advanced_settings).toStrictEqual({ max_results: 7, source_policy: { include_domains: ["python.org"] } });
    });

    it("Parallel caps the domain list at its documented 200", async () => {
        stubProvider({ results: [] });

        const blocklist = Array.from({ length: 250 }, (_, i) => `blocked${i}.org`);

        await run(blocklist, { maxResults: 7, provider: "parallel" });

        const policy = (sent[0]?.body.advanced_settings as { source_policy: { exclude_domains: string[] } }).source_policy;

        expect(policy.exclude_domains).toStrictEqual(blocklist.slice(0, 200));
    });

    it("Parallel results use excerpts and publish_date, fall back to the url for a missing title, and still honour the blocklist", async () => {
        stubProvider({
            results: [
                { excerpts: ["first", "second"], publish_date: "2025-11-19", title: "Doc", url: "https://ok.org/a" },
                { excerpts: ["only"], publish_date: null, title: null, url: "https://ok.org/b" },
                { excerpts: ["x"], publish_date: null, title: "Blocked", url: "https://spam.io/c" },
            ],
        });

        const output = await run(["spam.io"], { maxResults: 7, provider: "parallel" });

        expect(output.results[0]?.results).toStrictEqual([
            { content: "first\n\nsecond", publishedDate: "2025-11-19", title: "Doc", url: "https://ok.org/a" },
            { content: "only", publishedDate: undefined, title: "https://ok.org/b", url: "https://ok.org/b" },
        ]);
    });

    it("Parallel keeps the other results when one has no excerpts, and reads a missing results list as none", async () => {
        stubProvider({
            results: [
                { excerpts: null, title: "Bare", url: "https://ok.org/a" },
                { excerpts: ["kept"], title: "Kept", url: "https://ok.org/b" },
            ],
        });

        const output = await run([], { maxResults: 7, provider: "parallel" });

        expect(output.results[0]?.results).toStrictEqual([
            { content: "", publishedDate: undefined, title: "Bare", url: "https://ok.org/a" },
            { content: "kept", publishedDate: undefined, title: "Kept", url: "https://ok.org/b" },
        ]);
    });
});
