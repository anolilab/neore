/**
 * Tools Index
 * Exports all available tools for the AI agent
 */

// Import all tools for local use in helper functions
import academicSearchTool from "./academic-search";
import askUserTool from "./ask-user";
import browserTool from "./browser";
import canvasAITool from "./canvas-ai";
import codeExecutionTool from "./code-execution";
import codeSearchTool from "./code-search";
import companySearchTool from "./company-search";
import createDesignTool from "./create-design";
import createDocumentTool from "./create-document";
import createPresentationTool from "./create-presentation";
import { coinDataByContractTool, coinDataTool, coinOhlcTool } from "./crypto-tools";
import { currencyConverterTool, listCurrenciesTool } from "./currency-converter";
import datetimeTool from "./datetime";
import deepResearchTool from "./deep-research";
import delegateToCodingAgentTool from "./delegate-to-coding-agent";
import delegateToSubAgentTool from "./delegate-to-sub-agent";
import deepfakeDetectionTool from "./deepfake-detection";
import fileOperationsTool from "./file-operations";
import flightTrackerTool from "./flight-tracker";
import githubSearchTool from "./github-search";
import imageEditingTool from "./image-editing";
import imageGenerationTool from "./image-generation";
import imageSearchTool from "./image-search";
import knowledgeSearchTool from "./knowledge-search";
import { findPlaceTool, nearbyPlacesSearchTool } from "./map-tools";
import movieTvSearchTool from "./movie-tv-search";
import musicGenerationTool from "./music-generation";
import peopleSearchTool from "./people-search";
import redditSearchTool from "./reddit-search";
import renderUITool from "./render-ui";
import retrieveTool from "./retrieve";
import searchMemoryTool from "./search-memory";
import shellExecutionTool from "./shell-execution";
import spotifySearchTool from "./spotify-search";
import stockChartTool from "./stock-chart";
import taskListTool from "./task-list";
import { listLanguagesTool, textTranslateTool } from "./text-translate";
// ─── Tool Availability ─────────────────────────────────────────────────────────
// Import locally for use in helper functions below
import { getMissingEnvVariables, isToolAvailable } from "./tool-env-requirements";
import { trendingMoviesTool, trendingTvTool } from "./trending-media";
import updateDesignTool from "./update-design";
import updateDocumentTool from "./update-document";
import updateSlideTool from "./update-slide";
import videoGenerationTool from "./video-generation";
import videoSearchTool from "./video-search";
import visionAnalysisTool from "./vision-analysis";
import weatherTool from "./weather";
import webSearchTool from "./web-search";
import wolframAlphaTool from "./wolfram-alpha";
import xSearchTool from "./x-search";
import youtubeSearchTool from "./youtube-search";

export type { AcademicResult } from "./academic-search";
// Re-export all tools
export { default as academicSearchTool } from "./academic-search";
export type { AskUserInput, AskUserOutput } from "./ask-user";
export { default as askUserTool } from "./ask-user";
export type { BrowserResult } from "./browser";
export { default as browserTool } from "./browser";
export { default as canvasAITool } from "./canvas-ai";
export { default as codeExecutionTool } from "./code-execution";
export type { StackOverflowAnswer, StackOverflowQuestion } from "./code-search";
export { default as codeSearchTool } from "./code-search";
export { default as companySearchTool } from "./company-search";
export { default as createDesignTool } from "./create-design";
export { default as createDocumentTool } from "./create-document";
export { default as createPresentationTool } from "./create-presentation";
export type { CoinData, OHLCData } from "./crypto-tools";
export { coinDataByContractTool, coinDataTool, coinOhlcTool } from "./crypto-tools";
export type { ConversionResult } from "./currency-converter";
export { currencyConverterTool, listCurrenciesTool } from "./currency-converter";
export { default as datetimeTool } from "./datetime";
export { default as deepResearchTool } from "./deep-research";
export { default as deepfakeDetectionTool } from "./deepfake-detection";
export type { DelegateToCodingAgentOutput } from "./delegate-to-coding-agent";
export { default as delegateToCodingAgentTool } from "./delegate-to-coding-agent";
export type { DelegateToSubAgentOutput } from "./delegate-to-sub-agent";
export { default as delegateToSubAgentTool } from "./delegate-to-sub-agent";
export { default as fileOperationsTool } from "./file-operations";
export type { FlightData } from "./flight-tracker";
export { default as flightTrackerTool } from "./flight-tracker";
export type { GitHubCodeResult, GitHubIssue, GitHubRepoInfo } from "./github-search";
export { default as githubSearchTool } from "./github-search";
export { default as imageEditingTool } from "./image-editing";
export { default as imageGenerationTool } from "./image-generation";
export { default as imageSearchTool } from "./image-search";
export { default as knowledgeSearchTool } from "./knowledge-search";
export type { GeocodingResult, NearbyPlace } from "./map-tools";
export { findPlaceTool, nearbyPlacesSearchTool } from "./map-tools";
export type { MediaDetails, MediaResult } from "./movie-tv-search";
export { default as movieTvSearchTool } from "./movie-tv-search";
export { default as musicGenerationTool } from "./music-generation";
export { default as peopleSearchTool } from "./people-search";
export type { RedditPost } from "./reddit-search";
export { default as redditSearchTool } from "./reddit-search";
export type { RenderUIOutput } from "./render-ui";
export { default as renderUITool } from "./render-ui";
export type { RetrievedContent } from "./retrieve";
export { default as retrieveTool } from "./retrieve";
export { default as searchMemoryTool } from "./search-memory";
export { default as shellExecutionTool } from "./shell-execution";
export type { SpotifyAlbum, SpotifyArtist, SpotifyPlaylist, SpotifyShow, SpotifyTrack } from "./spotify-search";
export { default as spotifySearchTool } from "./spotify-search";
export type { StockNews, StockPrice, StockQuote } from "./stock-chart";
export { default as stockChartTool } from "./stock-chart";
export type { Task } from "./task-list";
export { default as taskListTool } from "./task-list";
export { listLanguagesTool, textTranslateTool } from "./text-translate";
// Re-export from shared constants (single source of truth)
export { ALWAYS_AVAILABLE_TOOLS, getMissingEnvVariables, isToolAvailable, TOOL_ENV_REQUIREMENTS, TOOL_ENV_REQUIREMENTS_OR } from "./tool-env-requirements";
export type { TrendingItem } from "./trending-media";
export { trendingMoviesTool, trendingTvTool } from "./trending-media";
export { default as updateDesignTool } from "./update-design";
export { default as updateDocumentTool } from "./update-document";
export { default as updateSlideTool } from "./update-slide";
// Utils
export {
    batchArray,
    deduplicateByDomainAndUrl,
    deduplicateByUrl,
    extractDomain,
    formatError,
    haversineDistance,
    isDefined,
    safeJsonParse,
    sleep,
    truncateText,
    withRetry,
} from "./utilities";
export { default as videoGenerationTool } from "./video-generation";
export { default as videoSearchTool } from "./video-search";
export { default as visionAnalysisTool } from "./vision-analysis";
export { default as weatherTool } from "./weather";
export { default as webSearchTool } from "./web-search";
export { default as wolframAlphaTool } from "./wolfram-alpha";
export type { XPost } from "./x-search";
export { default as xSearchTool } from "./x-search";
export type { YouTubeVideo } from "./youtube-search";
export { default as youtubeSearchTool } from "./youtube-search";

/**
 * Tool name enum for type-safe tool references
 */
export enum ToolName {
    AcademicSearch = "academicSearch",
    // Asking the user mid-run
    AskUser = "askUser",

    // Browser Tools
    Browser = "browser",
    // Design Tools
    CanvasAI = "canvasAI",
    // Code Execution Tools
    CodeExecution = "codeExecution",
    CodeSearch = "codeSearch",
    // Finance Tools
    CoinData = "coinData",
    CoinDataByContract = "coinDataByContract",
    CoinOhlc = "coinOhlc",
    CompanySearch = "companySearch",

    CreateDesign = "createDesign",

    // Document/Artifact Tools
    CreateDocument = "createDocument",
    // Presentation Tools
    CreatePresentation = "createPresentation",

    CurrencyConverter = "currencyConverter",
    DateTime = "dateTime",
    DeepfakeDetection = "deepfakeDetection",
    // Research Tools
    DeepResearch = "deepResearch",
    // Coding Agent Delegation
    DelegateToCodingAgent = "delegateToCodingAgent",
    // Sub-agent Delegation
    DelegateToSubAgent = "delegateToSubAgent",
    FileOperations = "fileOperations",
    // Location Tools
    FindPlace = "findPlace",

    // Travel Tools
    FlightTracker = "flightTracker",
    GithubSearch = "githubSearch",

    // Image Editing Tools
    ImageEditing = "imageEditing",

    // Image/Video/Music Generation Tools
    ImageGeneration = "imageGeneration",
    // Image/Video Search Tools
    ImageSearch = "imageSearch",
    // Knowledge Base Tools
    KnowledgeSearch = "knowledgeSearch",

    ListCurrencies = "listCurrencies",
    ListLanguages = "listLanguages",

    // Entertainment Tools
    MovieTvSearch = "movieTvSearch",
    MusicGeneration = "musicGeneration",

    NearbyPlacesSearch = "nearbyPlacesSearch",
    // People & Company Search Tools
    PeopleSearch = "peopleSearch",

    RedditSearch = "redditSearch",

    // Generative UI Tools
    RenderUI = "renderUI",

    // Content Tools
    Retrieve = "retrieve",
    // Memory Tools
    SearchMemory = "searchMemory",

    // Sandbox Tools
    ShellExecution = "shellExecution",

    SpotifySearch = "spotifySearch",
    StockChart = "stockChart",
    // Task Management Tools
    TaskList = "taskList",

    // Language Tools
    TextTranslate = "textTranslate",

    TrendingMovies = "trendingMovies",
    TrendingTv = "trendingTv",

    UpdateDesign = "updateDesign",

    UpdateDocument = "updateDocument",
    UpdateSlide = "updateSlide",

    VideoGeneration = "videoGeneration",

    VideoSearch = "videoSearch",
    // Vision / Analysis Tools
    VisionAnalysis = "visionAnalysis",

    // Information Tools
    Weather = "weather",

    // Search Tools
    WebSearch = "webSearch",
    // Computation Tools
    WolframAlpha = "wolframAlpha",
    XSearch = "xSearch",

    YoutubeSearch = "youtubeSearch",
}

/**
 * Get a summary of tool availability for logging/debugging.
 * Returns { available: string[], unavailable: { tool: string, missing: string[] }[] }.
 */
export const getToolAvailabilitySummary = (): {
    available: string[];
    unavailable: { missing: string[]; tool: string }[];
} => {
    const available: string[] = [];
    const unavailable: { missing: string[]; tool: string }[] = [];

    for (const toolName of Object.values(ToolName)) {
        // Use isToolAvailable() for consistent logic (handles browser dual-provider, etc.)
        if (isToolAvailable(toolName)) {
            available.push(toolName);
        } else {
            const missing = getMissingEnvVariables(toolName);

            unavailable.push({ missing, tool: toolName });
        }
    }

    return { available, unavailable };
};

/**
 * Get all available tools as a toolset.
 */
export const getAllTools = () => {
    return {
        [ToolName.AcademicSearch]: academicSearchTool,
        [ToolName.AskUser]: askUserTool,
        [ToolName.Browser]: browserTool,
        [ToolName.CanvasAI]: canvasAITool,
        [ToolName.CodeExecution]: codeExecutionTool,
        [ToolName.CodeSearch]: codeSearchTool,
        [ToolName.CoinData]: coinDataTool,
        [ToolName.CoinDataByContract]: coinDataByContractTool,
        [ToolName.CoinOhlc]: coinOhlcTool,
        [ToolName.CompanySearch]: companySearchTool,
        [ToolName.CreateDesign]: createDesignTool,
        [ToolName.CreateDocument]: createDocumentTool,
        [ToolName.CreatePresentation]: createPresentationTool,
        [ToolName.CurrencyConverter]: currencyConverterTool,
        [ToolName.DateTime]: datetimeTool,
        [ToolName.DeepfakeDetection]: deepfakeDetectionTool,
        [ToolName.DeepResearch]: deepResearchTool,
        [ToolName.DelegateToCodingAgent]: delegateToCodingAgentTool,
        [ToolName.DelegateToSubAgent]: delegateToSubAgentTool,
        [ToolName.FileOperations]: fileOperationsTool,
        [ToolName.FindPlace]: findPlaceTool,
        [ToolName.FlightTracker]: flightTrackerTool,
        [ToolName.GithubSearch]: githubSearchTool,
        [ToolName.ImageEditing]: imageEditingTool,
        [ToolName.ImageGeneration]: imageGenerationTool,
        [ToolName.ImageSearch]: imageSearchTool,
        [ToolName.KnowledgeSearch]: knowledgeSearchTool,
        [ToolName.ListCurrencies]: listCurrenciesTool,
        [ToolName.ListLanguages]: listLanguagesTool,
        [ToolName.MovieTvSearch]: movieTvSearchTool,
        [ToolName.MusicGeneration]: musicGenerationTool,
        [ToolName.NearbyPlacesSearch]: nearbyPlacesSearchTool,
        [ToolName.PeopleSearch]: peopleSearchTool,
        [ToolName.RedditSearch]: redditSearchTool,
        [ToolName.RenderUI]: renderUITool,
        [ToolName.Retrieve]: retrieveTool,
        [ToolName.SearchMemory]: searchMemoryTool,
        [ToolName.ShellExecution]: shellExecutionTool,
        [ToolName.SpotifySearch]: spotifySearchTool,
        [ToolName.StockChart]: stockChartTool,
        [ToolName.TaskList]: taskListTool,
        [ToolName.TextTranslate]: textTranslateTool,
        [ToolName.TrendingMovies]: trendingMoviesTool,
        [ToolName.TrendingTv]: trendingTvTool,
        [ToolName.UpdateDesign]: updateDesignTool,
        [ToolName.UpdateDocument]: updateDocumentTool,
        [ToolName.UpdateSlide]: updateSlideTool,
        [ToolName.VideoGeneration]: videoGenerationTool,
        [ToolName.VideoSearch]: videoSearchTool,
        [ToolName.VisionAnalysis]: visionAnalysisTool,
        [ToolName.Weather]: weatherTool,
        [ToolName.WebSearch]: webSearchTool,
        [ToolName.WolframAlpha]: wolframAlphaTool,
        [ToolName.XSearch]: xSearchTool,
        [ToolName.YoutubeSearch]: youtubeSearchTool,
    };
};

/**
 * Get search tools only.
 */
export const getSearchTools = () => {
    return {
        [ToolName.AcademicSearch]: academicSearchTool,
        [ToolName.CodeSearch]: codeSearchTool,
        [ToolName.CompanySearch]: companySearchTool,
        [ToolName.GithubSearch]: githubSearchTool,
        [ToolName.PeopleSearch]: peopleSearchTool,
        [ToolName.RedditSearch]: redditSearchTool,
        [ToolName.SpotifySearch]: spotifySearchTool,
        [ToolName.WebSearch]: webSearchTool,
        [ToolName.XSearch]: xSearchTool,
        [ToolName.YoutubeSearch]: youtubeSearchTool,
    };
};

/**
 * Get finance tools only.
 */
export const getFinanceTools = () => {
    return {
        [ToolName.CoinData]: coinDataTool,
        [ToolName.CoinDataByContract]: coinDataByContractTool,
        [ToolName.CoinOhlc]: coinOhlcTool,
        [ToolName.CurrencyConverter]: currencyConverterTool,
        [ToolName.StockChart]: stockChartTool,
    };
};

/**
 * Get entertainment tools only.
 */
export const getEntertainmentTools = () => {
    return {
        [ToolName.MovieTvSearch]: movieTvSearchTool,
        [ToolName.TrendingMovies]: trendingMoviesTool,
        [ToolName.TrendingTv]: trendingTvTool,
    };
};

/**
 * Get location tools only.
 */
export const getLocationTools = () => {
    return {
        [ToolName.FindPlace]: findPlaceTool,
        [ToolName.NearbyPlacesSearch]: nearbyPlacesSearchTool,
        [ToolName.Weather]: weatherTool,
    };
};

/**
 * Get utility tools only.
 */
export const getUtilityTools = () => {
    return {
        [ToolName.DateTime]: datetimeTool,
        [ToolName.ListCurrencies]: listCurrenciesTool,
        [ToolName.ListLanguages]: listLanguagesTool,
        [ToolName.Retrieve]: retrieveTool,
        [ToolName.TextTranslate]: textTranslateTool,
    };
};
