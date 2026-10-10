/**
 * Which built-in tools a search mode offers. The default Chat mode carries
 * `dateTime` (a product decision): it needs no provider key, so a plain chat
 * can always answer "what day is it" without switching modes.
 */
import { describe, expect, it, vi } from "vitest";

import { buildToolsForSearchMode } from "./tool-builder";

// The real `../tools` barrel pulls in every tool's runtime. The mapping under
// test only needs the enum and something truthy per tool name.
vi.mock("../tools", () => {
    const toolNames = [
        "academicSearch",
        "askUser",
        "browser",
        "canvasAI",
        "codeExecution",
        "codeSearch",
        "coinDataByContract",
        "coinData",
        "coinOhlc",
        "companySearch",
        "createDesign",
        "createDocument",
        "createPresentation",
        "currencyConverter",
        "datetime",
        "deepfakeDetection",
        "deepResearch",
        "delegateToCodingAgent",
        "delegateToSubAgent",
        "fileOperations",
        "findPlace",
        "flightTracker",
        "githubSearch",
        "imageEditing",
        "imageGeneration",
        "imageSearch",
        "knowledgeSearch",
        "listCurrencies",
        "listLanguages",
        "movieTvSearch",
        "musicGeneration",
        "nearbyPlacesSearch",
        "peopleSearch",
        "redditSearch",
        "renderUI",
        "retrieve",
        "searchMemory",
        "shellExecution",
        "spotifySearch",
        "stockChart",
        "taskList",
        "textTranslate",
        "trendingMovies",
        "trendingTv",
        "updateDesign",
        "updateDocument",
        "updateSlide",
        "videoGeneration",
        "videoSearch",
        "visionAnalysis",
        "weather",
        "webSearch",
        "wolframAlpha",
        "xSearch",
        "youtubeSearch",
    ];
    const tools = Object.fromEntries(toolNames.map((name) => [`${name}Tool`, { description: name }]));

    return {
        ...tools,
        isToolAvailable: () => true,
        // `ToolName.DateTime` → "dateTime": every member is its key, first letter lowered.
        ToolName: new Proxy({}, { get: (_target, key) => (typeof key === "string" ? key.charAt(0).toLowerCase() + key.slice(1) : undefined) }),
    };
});

describe("buildToolsForSearchMode", () => {
    it("offers dateTime in the default Chat mode", () => {
        expect(Object.keys(buildToolsForSearchMode("chat"))).toContain("dateTime");
    });
});
