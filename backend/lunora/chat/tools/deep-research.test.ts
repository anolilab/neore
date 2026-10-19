/**
 * The deep research search call: the user's blocklist goes to Tavily and Exa as
 * their exclude list, and a blocked result a provider returns anyway is dropped.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../_generated/internal", () => {
    return { internal: {} };
});
vi.mock("../../agent/client", () => {
    return { createTool: (definition: unknown) => definition };
});

type ResearchSearch = (query: string, maxResults: number, blocklist?: string[]) => Promise<{ url: string }[]>;

/** The module reads its keys at load, so each provider set gets a fresh import. */
const loadResearchSearch = async (keys: { EXA_API_KEY?: string; TAVILY_API_KEY?: string }): Promise<ResearchSearch> => {
    vi.resetModules();
    vi.doMock("../../env", () => {
        return { EXA_API_KEY: keys.EXA_API_KEY, PARALLEL_API_KEY: undefined, TAVILY_API_KEY: keys.TAVILY_API_KEY };
    });

    const module = await import("./deep-research");

    return module.researchSearch;
};

const sent: { body: Record<string, unknown>; url: string }[] = [];

const stubProvider = (results: unknown) => {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
        sent.push({ body: JSON.parse(String(init.body)) as Record<string, unknown>, url });

        return Response.json(results, { headers: { "content-type": "application/json" } });
    });
};

afterEach(() => {
    vi.unstubAllGlobals();
    vi.doUnmock("../../env");
    sent.length = 0;
});

describe("researchSearch", () => {
    it("sends the blocklist as Tavily exclude_domains and drops a blocked result the provider returned anyway", async () => {
        const search = await loadResearchSearch({ TAVILY_API_KEY: "tav-key" });

        stubProvider({
            results: [
                { content: "a", title: "a", url: "https://docs.example.com/a" },
                { content: "b", title: "b", url: "https://ok.org/b" },
            ],
        });

        const results = await search("q", 5, ["example.com", "ads.net"]);

        expect(sent).toStrictEqual([
            {
                body: {
                    api_key: "tav-key",
                    exclude_domains: ["example.com", "ads.net"],
                    include_answer: false,
                    include_images: false,
                    max_results: 5,
                    query: "q",
                    search_depth: "advanced",
                    topic: "general",
                },
                url: "https://api.tavily.com/search",
            },
        ]);
        expect(results.map((r) => r.url)).toStrictEqual(["https://ok.org/b"]);
    });

    it("omits Tavily exclude_domains when the blocklist is empty", async () => {
        const search = await loadResearchSearch({ TAVILY_API_KEY: "tav-key" });

        stubProvider({ results: [] });

        await search("q", 5, []);

        expect(sent[0]?.body).not.toHaveProperty("exclude_domains");
    });

    it("caps Tavily exclude_domains at its documented 150", async () => {
        const search = await loadResearchSearch({ TAVILY_API_KEY: "tav-key" });

        stubProvider({ results: [] });

        const blocklist = Array.from({ length: 160 }, (_, i) => `blocked${i}.org`);

        await search("q", 5, blocklist);

        expect(sent[0]?.body.exclude_domains).toStrictEqual(blocklist.slice(0, 150));
    });

    it("sends the blocklist as Exa excludeDomains with camelCase keys on the fallback path", async () => {
        const search = await loadResearchSearch({ EXA_API_KEY: "exa-key" });

        stubProvider({
            results: [
                { text: "a", title: "a", url: "https://docs.example.com/a" },
                { text: "b", title: "b", url: "https://ok.org/b" },
            ],
        });

        const results = await search("q", 5, ["example.com"]);

        expect(sent).toStrictEqual([
            {
                body: {
                    contents: { text: { maxCharacters: 3000 } },
                    excludeDomains: ["example.com"],
                    numResults: 5,
                    query: "q",
                    use_autoprompt: true,
                },
                url: "https://api.exa.ai/search",
            },
        ]);
        expect(results.map((r) => r.url)).toStrictEqual(["https://ok.org/b"]);
    });
});
