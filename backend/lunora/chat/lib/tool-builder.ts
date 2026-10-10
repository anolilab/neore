/**
 * Chat Tools Builder
 * Creates and configures tools for chat streaming context
 */
import { isToolCallUnsupportedModel, staticUnsupportedModels } from "@neore/ai/models";
import type { LanguageModel, ToolSet } from "ai";

import { toolsLogger } from "../../lib/logger";
import {
    academicSearchTool,
    askUserTool,
    browserTool,
    canvasAITool,
    codeExecutionTool,
    codeSearchTool,
    coinDataByContractTool,
    coinDataTool,
    coinOhlcTool,
    companySearchTool,
    createDesignTool,
    createDocumentTool,
    createPresentationTool,
    currencyConverterTool,
    datetimeTool,
    deepfakeDetectionTool,
    deepResearchTool,
    delegateToCodingAgentTool,
    delegateToSubAgentTool,
    fileOperationsTool,
    findPlaceTool,
    flightTrackerTool,
    githubSearchTool,
    imageEditingTool,
    imageGenerationTool,
    imageSearchTool,
    isToolAvailable,
    knowledgeSearchTool,
    listCurrenciesTool,
    listLanguagesTool,
    movieTvSearchTool,
    musicGenerationTool,
    nearbyPlacesSearchTool,
    peopleSearchTool,
    redditSearchTool,
    renderUITool,
    retrieveTool,
    searchMemoryTool,
    shellExecutionTool,
    spotifySearchTool,
    stockChartTool,
    taskListTool,
    textTranslateTool,
    ToolName,
    trendingMoviesTool,
    trendingTvTool,
    updateDesignTool,
    updateDocumentTool,
    updateSlideTool,
    videoGenerationTool,
    videoSearchTool,
    visionAnalysisTool,
    weatherTool,
    webSearchTool,
    wolframAlphaTool,
    xSearchTool,
    youtubeSearchTool,
} from "../tools";

/**
 * Search mode types - determines which tools are active
 */
export type SearchMode =
    | "chat" // No tools - direct conversation
    | "writing" // Writing assistant - no search, creative tools only
    | "web" // Web search tools
    | "academic" // Academic paper search
    | "x" // X/Twitter search
    | "reddit" // Reddit search
    | "youtube" // YouTube search
    | "stocks" // Stock and currency tools
    | "crypto" // Cryptocurrency tools
    | "code" // Code/Stack Overflow search
    | "github" // GitHub search
    | "spotify" // Spotify search
    | "wolfram"; // Wolfram Alpha computation

/**
 * Search mode metadata for UI
 */
export interface SearchModeInfo {
    description: string;
    enabled: boolean; // Whether this mode is implemented
    icon: string; // Icon name for lucide-react
    id: SearchMode;
    label: string;
}

/**
 * All available search modes with metadata
 */
export const SEARCH_MODES: SearchModeInfo[] = [
    { description: "Talk to the model directly", enabled: true, icon: "MessageSquare", id: "chat", label: "Chat" },
    { description: "Creative writing assistant without web search", enabled: true, icon: "PenTool", id: "writing", label: "Writing" },
    { description: "Search across the entire internet", enabled: true, icon: "Globe", id: "web", label: "Web" },
    { description: "Search academic papers and PDFs", enabled: true, icon: "GraduationCap", id: "academic", label: "Academic" },
    { description: "Math, science, and computational queries", enabled: true, icon: "Calculator", id: "wolfram", label: "Wolfram" },
    { description: "Search X posts", enabled: true, icon: "Twitter", id: "x", label: "X" },
    { description: "Search Reddit posts", enabled: true, icon: "MessageCircle", id: "reddit", label: "Reddit" },
    { description: "Search YouTube videos and channels", enabled: true, icon: "Youtube", id: "youtube", label: "YouTube" },
    { description: "Stock and currency information", enabled: true, icon: "TrendingUp", id: "stocks", label: "Stocks" },
    { description: "Cryptocurrency research", enabled: true, icon: "Bitcoin", id: "crypto", label: "Crypto" },
    { description: "Search Stack Overflow for programming help", enabled: true, icon: "Code", id: "code", label: "Code" },
    { description: "Search GitHub repositories and code", enabled: true, icon: "Github", id: "github", label: "GitHub" },
    { description: "Search songs, artists, and albums", enabled: true, icon: "Music", id: "spotify", label: "Spotify" },
];

/**
 * Map search modes to tool names
 */
// Document tools are available in all search modes
const DOCUMENT_TOOLS = [ToolName.CreateDocument, ToolName.UpdateDocument, ToolName.RenderUI];
// Memory search is available in all modes for progressive disclosure
const MEMORY_TOOLS = [ToolName.SearchMemory];
// Knowledge base search is available in all modes
const KNOWLEDGE_TOOLS = [ToolName.KnowledgeSearch];
// Sandbox tools (shell + file ops) for agentic modes
const SANDBOX_TOOLS = [ToolName.ShellExecution, ToolName.FileOperations];
// Delegation to an external coding agent (Claude Code / Codex); asks before every run by default
const CODING_AGENT_TOOLS = [ToolName.DelegateToCodingAgent];
// Asking the user mid-run: every mode, since any conversation can hit an ambiguity.
// Headless runs lose it (`tool-permissions.ts`), as nobody is there to answer.
const INTERACTION_TOOLS = [ToolName.AskUser];
// Delegating a self-contained piece of work to a headless sub-agent (`sub-agents/`)
const SUB_AGENT_TOOLS = [ToolName.DelegateToSubAgent];

const SEARCH_MODE_TOOLS: Record<SearchMode, ToolName[]> = {
    academic: [
        ToolName.AcademicSearch,
        ToolName.Retrieve,
        ToolName.DateTime,
        ...SUB_AGENT_TOOLS,
        ...DOCUMENT_TOOLS,
        ...MEMORY_TOOLS,
        ...INTERACTION_TOOLS,
        ...KNOWLEDGE_TOOLS,
    ],
    chat: [
        ToolName.CodeExecution,
        ToolName.Browser,
        ToolName.DateTime,
        ...SANDBOX_TOOLS,
        ...CODING_AGENT_TOOLS,
        ...SUB_AGENT_TOOLS,
        ...DOCUMENT_TOOLS,
        ...MEMORY_TOOLS,
        ...INTERACTION_TOOLS,
        ...KNOWLEDGE_TOOLS,
    ],
    code: [
        ToolName.CodeSearch,
        ToolName.CodeExecution,
        ToolName.DateTime,
        ...SANDBOX_TOOLS,
        ...CODING_AGENT_TOOLS,
        ...SUB_AGENT_TOOLS,
        ...DOCUMENT_TOOLS,
        ...MEMORY_TOOLS,
        ...INTERACTION_TOOLS,
        ...KNOWLEDGE_TOOLS,
    ],
    crypto: [
        ToolName.CoinData,
        ToolName.CoinDataByContract,
        ToolName.CoinOhlc,
        ToolName.DateTime,
        ...DOCUMENT_TOOLS,
        ...MEMORY_TOOLS,
        ...INTERACTION_TOOLS,
        ...KNOWLEDGE_TOOLS,
    ],
    github: [ToolName.GithubSearch, ToolName.DateTime, ...CODING_AGENT_TOOLS, ...DOCUMENT_TOOLS, ...MEMORY_TOOLS, ...INTERACTION_TOOLS, ...KNOWLEDGE_TOOLS],
    reddit: [ToolName.RedditSearch, ToolName.DateTime, ...DOCUMENT_TOOLS, ...MEMORY_TOOLS, ...INTERACTION_TOOLS, ...KNOWLEDGE_TOOLS],
    spotify: [ToolName.SpotifySearch, ToolName.DateTime, ...DOCUMENT_TOOLS, ...MEMORY_TOOLS, ...INTERACTION_TOOLS, ...KNOWLEDGE_TOOLS],
    stocks: [
        ToolName.StockChart,
        ToolName.CurrencyConverter,
        ToolName.ListCurrencies,
        ToolName.DateTime,
        ...DOCUMENT_TOOLS,
        ...MEMORY_TOOLS,
        ...INTERACTION_TOOLS,
        ...KNOWLEDGE_TOOLS,
    ],
    web: [
        ToolName.WebSearch,
        ToolName.ImageSearch,
        ToolName.VideoSearch,
        ToolName.Retrieve,
        ToolName.DateTime,
        ToolName.DeepResearch,
        ToolName.CodeExecution,
        ToolName.CurrencyConverter,
        ToolName.Browser,
        ...SANDBOX_TOOLS,
        ...SUB_AGENT_TOOLS,
        ...DOCUMENT_TOOLS,
        ...MEMORY_TOOLS,
        ...INTERACTION_TOOLS,
        ...KNOWLEDGE_TOOLS,
    ],
    wolfram: [ToolName.WolframAlpha, ToolName.CodeExecution, ToolName.DateTime, ...DOCUMENT_TOOLS, ...MEMORY_TOOLS, ...INTERACTION_TOOLS, ...KNOWLEDGE_TOOLS],
    writing: [
        ToolName.TextTranslate,
        ToolName.ListLanguages,
        ToolName.CodeExecution,
        ...SANDBOX_TOOLS,
        ...DOCUMENT_TOOLS,
        ...MEMORY_TOOLS,
        ...INTERACTION_TOOLS,
        ...KNOWLEDGE_TOOLS,
    ],
    x: [ToolName.XSearch, ToolName.DateTime, ...DOCUMENT_TOOLS, ...MEMORY_TOOLS, ...INTERACTION_TOOLS, ...KNOWLEDGE_TOOLS],
    youtube: [ToolName.YoutubeSearch, ToolName.DateTime, ...DOCUMENT_TOOLS, ...MEMORY_TOOLS, ...INTERACTION_TOOLS, ...KNOWLEDGE_TOOLS],
};

/**
 * Tool configuration options
 */
export interface ToolBuilderOptions {
    /**
     * Enable browser automation tool (Browserbase)
     */
    enableBrowser?: boolean;

    /**
     * Enable code execution tools (Python sandbox)
     */
    enableCodeExecution?: boolean;

    /**
     * Enable computation tools (Wolfram Alpha)
     */
    enableComputation?: boolean;

    /**
     * Enable document/artifact tools (create, update documents)
     */
    enableDocument?: boolean;

    /**
     * Enable entertainment tools (movies, tv)
     */
    enableEntertainment?: boolean;

    /**
     * Enable finance tools (crypto, stocks, currency)
     */
    enableFinance?: boolean;

    /**
     * Enable image/video generation tools (FAL.ai)
     */
    enableGeneration?: boolean;

    /**
     * Enable knowledge base search tool (RAG)
     */
    enableKnowledge?: boolean;

    /**
     * Enable location tools (maps, weather)
     */
    enableLocation?: boolean;

    /**
     * Enable memory search tool (search_memory progressive disclosure)
     */
    enableMemory?: boolean;

    /**
     * Enable research tools (deep research)
     */
    enableResearch?: boolean;

    /**
     * Enable sandbox tools (shell execution, file operations)
     */
    enableSandbox?: boolean;

    /**
     * Enable search tools (web, academic, youtube, reddit, x)
     */
    enableSearch?: boolean;

    /**
     * Enable travel tools (flights)
     */
    enableTravel?: boolean;

    /**
     * Enable utility tools (datetime, translate, retrieve)
     */
    enableUtility?: boolean;

    /**
     * Specific tools to exclude
     */
    excludeTools?: ToolName[];

    /**
     * Specific tools to include (overrides category settings)
     */
    includeTools?: ToolName[];
}

/**
 * All available tools mapped by name
 */
const ALL_TOOLS: Record<ToolName, unknown> = {
    [ToolName.AcademicSearch]: academicSearchTool,
    // Asking the user mid-run
    [ToolName.AskUser]: askUserTool,

    // Browser Tools
    [ToolName.Browser]: browserTool,
    // Design Tools
    [ToolName.CanvasAI]: canvasAITool,
    // Code Execution Tools
    [ToolName.CodeExecution]: codeExecutionTool,
    [ToolName.CodeSearch]: codeSearchTool,
    // Finance Tools
    [ToolName.CoinData]: coinDataTool,
    [ToolName.CoinDataByContract]: coinDataByContractTool,
    [ToolName.CoinOhlc]: coinOhlcTool,
    [ToolName.CompanySearch]: companySearchTool,

    [ToolName.CreateDesign]: createDesignTool,

    // Document/Artifact Tools
    [ToolName.CreateDocument]: createDocumentTool,
    [ToolName.CreatePresentation]: createPresentationTool,

    [ToolName.CurrencyConverter]: currencyConverterTool,
    [ToolName.DateTime]: datetimeTool,
    [ToolName.DeepfakeDetection]: deepfakeDetectionTool,
    // Research Tools
    [ToolName.DeepResearch]: deepResearchTool,
    // Coding Agent Delegation
    [ToolName.DelegateToCodingAgent]: delegateToCodingAgentTool,
    // Sub-agent Delegation
    [ToolName.DelegateToSubAgent]: delegateToSubAgentTool,
    [ToolName.FileOperations]: fileOperationsTool,
    // Location Tools
    [ToolName.FindPlace]: findPlaceTool,

    // Travel Tools
    [ToolName.FlightTracker]: flightTrackerTool,
    [ToolName.GithubSearch]: githubSearchTool,

    // Image Editing Tools
    [ToolName.ImageEditing]: imageEditingTool,

    // Image/Video/Music Generation Tools
    [ToolName.ImageGeneration]: imageGenerationTool,
    // Image/Video Search Tools
    [ToolName.ImageSearch]: imageSearchTool,
    // Knowledge Base Tools
    [ToolName.KnowledgeSearch]: knowledgeSearchTool,

    [ToolName.ListCurrencies]: listCurrenciesTool,
    [ToolName.ListLanguages]: listLanguagesTool,

    // Entertainment Tools
    [ToolName.MovieTvSearch]: movieTvSearchTool,
    [ToolName.MusicGeneration]: musicGenerationTool,
    [ToolName.NearbyPlacesSearch]: nearbyPlacesSearchTool,
    // People & Company Search Tools
    [ToolName.PeopleSearch]: peopleSearchTool,

    [ToolName.RedditSearch]: redditSearchTool,

    // Generative UI Tools
    [ToolName.RenderUI]: renderUITool,

    // Content Tools
    [ToolName.Retrieve]: retrieveTool,

    // Memory Tools
    [ToolName.SearchMemory]: searchMemoryTool,
    // Sandbox Tools
    [ToolName.ShellExecution]: shellExecutionTool,

    [ToolName.SpotifySearch]: spotifySearchTool,
    [ToolName.StockChart]: stockChartTool,
    // Task Management Tools
    [ToolName.TaskList]: taskListTool,

    // Language Tools
    [ToolName.TextTranslate]: textTranslateTool,

    [ToolName.TrendingMovies]: trendingMoviesTool,
    [ToolName.TrendingTv]: trendingTvTool,

    [ToolName.UpdateDesign]: updateDesignTool,

    [ToolName.UpdateDocument]: updateDocumentTool,

    [ToolName.UpdateSlide]: updateSlideTool,
    [ToolName.VideoGeneration]: videoGenerationTool,

    [ToolName.VideoSearch]: videoSearchTool,

    // Vision / Analysis Tools
    [ToolName.VisionAnalysis]: visionAnalysisTool,
    // Information Tools
    [ToolName.Weather]: weatherTool,

    // Search Tools
    [ToolName.WebSearch]: webSearchTool,

    // Computation Tools
    [ToolName.WolframAlpha]: wolframAlphaTool,
    [ToolName.XSearch]: xSearchTool,
    [ToolName.YoutubeSearch]: youtubeSearchTool,
};

/**
 * Tools grouped by category
 */
const TOOLS_BY_CATEGORY = {
    browser: [ToolName.Browser],
    codeExecution: [ToolName.CodeExecution],
    codingAgent: [ToolName.DelegateToCodingAgent],
    computation: [ToolName.WolframAlpha],
    document: [
        ToolName.CreateDocument,
        ToolName.UpdateDocument,
        ToolName.CreatePresentation,
        ToolName.UpdateSlide,
        ToolName.RenderUI,
        ToolName.CanvasAI,
        ToolName.CreateDesign,
        ToolName.UpdateDesign,
    ],
    entertainment: [ToolName.MovieTvSearch, ToolName.TrendingMovies, ToolName.TrendingTv],
    finance: [ToolName.CoinData, ToolName.CoinDataByContract, ToolName.CoinOhlc, ToolName.CurrencyConverter, ToolName.ListCurrencies, ToolName.StockChart],
    generation: [ToolName.ImageGeneration, ToolName.VideoGeneration, ToolName.MusicGeneration, ToolName.ImageEditing],
    interaction: [ToolName.AskUser],
    knowledge: [ToolName.KnowledgeSearch],
    location: [ToolName.FindPlace, ToolName.NearbyPlacesSearch, ToolName.Weather],
    memory: [ToolName.SearchMemory],
    research: [ToolName.DeepResearch],
    sandbox: [ToolName.ShellExecution, ToolName.FileOperations],
    search: [
        ToolName.WebSearch,
        ToolName.ImageSearch,
        ToolName.VideoSearch,
        ToolName.AcademicSearch,
        ToolName.YoutubeSearch,
        ToolName.RedditSearch,
        ToolName.XSearch,
        ToolName.GithubSearch,
        ToolName.SpotifySearch,
        ToolName.CodeSearch,
        ToolName.PeopleSearch,
        ToolName.CompanySearch,
    ],
    subAgent: [ToolName.DelegateToSubAgent],
    travel: [ToolName.FlightTracker],
    utility: [
        ToolName.DateTime,
        ToolName.TextTranslate,
        ToolName.ListLanguages,
        ToolName.Retrieve,
        ToolName.TaskList,
        ToolName.VisionAnalysis,
        ToolName.DeepfakeDetection,
    ],
} as const;

/**
 * Default tool configuration - enables all categories
 */
const DEFAULT_OPTIONS: ToolBuilderOptions = {
    enableBrowser: true,
    enableCodeExecution: true,
    enableComputation: true,
    enableDocument: true,
    enableEntertainment: true,
    enableFinance: true,
    enableGeneration: true,
    enableKnowledge: true,
    enableLocation: true,
    enableMemory: true,
    enableResearch: true,
    enableSandbox: true,
    enableSearch: true,
    enableTravel: true,
    enableUtility: true,
};

/**
 * Build a ToolSet based on configuration options.
 */
export const buildChatTools = (options: ToolBuilderOptions = DEFAULT_OPTIONS): ToolSet => {
    const {
        enableBrowser,
        enableCodeExecution,
        enableComputation,
        enableDocument,
        enableEntertainment,
        enableFinance,
        enableGeneration,
        enableKnowledge,
        enableLocation,
        enableMemory,
        enableResearch,
        enableSandbox,
        enableSearch,
        enableTravel,
        enableUtility,
        excludeTools = [],
        includeTools,
    } = options;

    const excludeSet = new Set(excludeTools);
    let selectedTools: ToolName[];

    if (includeTools && includeTools.length > 0) {
        // Use explicit include list
        selectedTools = includeTools.filter((t) => !excludeSet.has(t));
    } else {
        // Build from categories
        selectedTools = [];

        if (enableSearch) {
            selectedTools.push(...TOOLS_BY_CATEGORY.search);
        }

        if (enableFinance) {
            selectedTools.push(...TOOLS_BY_CATEGORY.finance);
        }

        if (enableEntertainment) {
            selectedTools.push(...TOOLS_BY_CATEGORY.entertainment);
        }

        if (enableLocation) {
            selectedTools.push(...TOOLS_BY_CATEGORY.location);
        }

        if (enableUtility) {
            selectedTools.push(...TOOLS_BY_CATEGORY.utility);
        }

        if (enableTravel) {
            selectedTools.push(...TOOLS_BY_CATEGORY.travel);
        }

        if (enableDocument) {
            selectedTools.push(...TOOLS_BY_CATEGORY.document);
        }

        if (enableResearch) {
            selectedTools.push(...TOOLS_BY_CATEGORY.research);
        }

        if (enableComputation) {
            selectedTools.push(...TOOLS_BY_CATEGORY.computation);
        }

        if (enableCodeExecution) {
            selectedTools.push(...TOOLS_BY_CATEGORY.codeExecution);
        }

        if (enableGeneration) {
            selectedTools.push(...TOOLS_BY_CATEGORY.generation);
        }

        if (enableMemory) {
            selectedTools.push(...TOOLS_BY_CATEGORY.memory);
        }

        if (enableBrowser) {
            selectedTools.push(...TOOLS_BY_CATEGORY.browser);
        }

        if (enableSandbox) {
            selectedTools.push(...TOOLS_BY_CATEGORY.sandbox, ...TOOLS_BY_CATEGORY.codingAgent);
        }

        if (enableKnowledge) {
            selectedTools.push(...TOOLS_BY_CATEGORY.knowledge);
        }

        // Remove excluded tools
        selectedTools = selectedTools.filter((t) => !excludeSet.has(t));
    }

    // Build the tool set, filtering out tools whose env vars are missing
    const toolSet: ToolSet = {};
    const skipped: string[] = [];

    for (const toolName of selectedTools) {
        const tool = ALL_TOOLS[toolName];

        if (!tool) {
            continue;
        }

        if (!isToolAvailable(toolName)) {
            skipped.push(toolName);
            continue;
        }

        toolSet[toolName] = tool as ToolSet[string];
    }

    if (skipped.length > 0) {
        toolsLogger.debug(`[TOOLS] Skipped ${skipped.length} unavailable tools: ${skipped.join(", ")}`);
    }

    return toolSet;
};

/**
 * Check if a model supports tool calling.
 */
export const modelSupportsTools = (model: LanguageModel | string): boolean => {
    if (typeof model === "string") {
        return !staticUnsupportedModels.has(model);
    }

    return !isToolCallUnsupportedModel(model);
};

/**
 * Get tools for a model, returning empty set if model doesn't support tools.
 */
export const getToolsForModel = (model: LanguageModel | string, options?: ToolBuilderOptions): ToolSet => {
    if (!modelSupportsTools(model)) {
        toolsLogger.debug(`[TOOLS] Model does not support tool calling, returning empty toolset`);

        return {};
    }

    return buildChatTools(options);
};

/**
 * Get the default chat tools (all categories enabled).
 */
export const getDefaultChatTools = (): ToolSet => buildChatTools(DEFAULT_OPTIONS);

/**
 * Get minimal tools for lightweight operations.
 */
export const getMinimalChatTools = (): ToolSet =>
    buildChatTools({
        enableUtility: true,
    });

/**
 * Get search-focused tools.
 */
export const getSearchChatTools = (): ToolSet =>
    buildChatTools({
        enableSearch: true,
        enableUtility: true,
    });

/**
 * Build tools for a specific search mode.
 */
export const buildToolsForSearchMode = (searchMode: SearchMode): ToolSet => {
    const toolNames = SEARCH_MODE_TOOLS[searchMode];

    if (!toolNames || toolNames.length === 0) {
        return {};
    }

    const toolSet: ToolSet = {};
    const skipped: string[] = [];

    for (const toolName of toolNames) {
        const tool = ALL_TOOLS[toolName];

        if (!tool) {
            continue;
        }

        if (!isToolAvailable(toolName)) {
            skipped.push(toolName);
            continue;
        }

        toolSet[toolName] = tool as ToolSet[string];
    }

    if (skipped.length > 0) {
        toolsLogger.debug(`[TOOLS] ${searchMode} mode: skipped ${skipped.length} unavailable tools: ${skipped.join(", ")}`);
    }

    return toolSet;
};

/**
 * Skill configuration for tool overrides
 */
export interface SkillToolConfig {
    additionalTools?: string[];
    disabledTools?: string[];
    searchMode?: string;
}

/**
 * Get tools for a model with a specific search mode and optional skill config
 * Returns empty set if model doesn't support tools or mode is "chat".
 */
export const getToolsForModelAndMode = (
    model: LanguageModel | string,
    searchMode: SearchMode = "chat",
    skillConfig?: SkillToolConfig,
    options?: { autoMediaEnrichment?: boolean },
): ToolSet => {
    // Check if model supports tools
    if (!modelSupportsTools(model)) {
        toolsLogger.debug(`[TOOLS] Model does not support tool calling, returning empty toolset`);

        return {};
    }

    // Apply skill searchMode override if present
    const effectiveSearchMode = (skillConfig?.searchMode as SearchMode) || searchMode;

    // Build base tools for search mode
    const tools = buildToolsForSearchMode(effectiveSearchMode);

    // Auto-inject image/video search when enabled and not already present (non-chat modes only)
    if (options?.autoMediaEnrichment && effectiveSearchMode !== "chat") {
        if (!Object.hasOwn(tools, ToolName.ImageSearch) && isToolAvailable(ToolName.ImageSearch)) {
            tools[ToolName.ImageSearch] = ALL_TOOLS[ToolName.ImageSearch] as ToolSet[string];
            toolsLogger.debug(`[TOOLS] Auto-injected ImageSearch (autoMediaEnrichment)`);
        }

        if (!Object.hasOwn(tools, ToolName.VideoSearch) && isToolAvailable(ToolName.VideoSearch)) {
            tools[ToolName.VideoSearch] = ALL_TOOLS[ToolName.VideoSearch] as ToolSet[string];
            toolsLogger.debug(`[TOOLS] Auto-injected VideoSearch (autoMediaEnrichment)`);
        }
    }

    // Apply skill tool overrides if present
    if (skillConfig) {
        // Add additional tools from skill config
        if (skillConfig.additionalTools && skillConfig.additionalTools.length > 0) {
            for (const toolName of skillConfig.additionalTools) {
                const tool = ALL_TOOLS[toolName as ToolName];

                if (tool) {
                    tools[toolName] = tool as ToolSet[string];
                    toolsLogger.debug(`[TOOLS] Added skill tool: ${toolName}`);
                } else {
                    toolsLogger.warn(`[TOOLS] Skill requested unknown tool: ${toolName}`);
                }
            }
        }

        // Remove disabled tools from skill config
        if (skillConfig.disabledTools && skillConfig.disabledTools.length > 0) {
            for (const toolName of skillConfig.disabledTools) {
                if (!Object.hasOwn(tools, toolName)) {
                    continue;
                }

                delete tools[toolName];
                toolsLogger.debug(`[TOOLS] Disabled skill tool: ${toolName}`);
            }
        }
    }

    return tools;
};

/**
 * Get enabled search modes only.
 */
export const getEnabledSearchModes = (): SearchModeInfo[] => SEARCH_MODES.filter((mode) => mode.enabled);

/**
 * Every built-in tool with its category and whether its env requirements are
 * met. Feeds the tool-permissions settings page.
 */
export const listBuiltInTools = (): { available: boolean; category: string; name: ToolName }[] => {
    const seen = new Set<ToolName>();
    const result: { available: boolean; category: string; name: ToolName }[] = [];

    for (const [category, names] of Object.entries(TOOLS_BY_CATEGORY)) {
        for (const name of names as ReadonlyArray<ToolName>) {
            if (seen.has(name)) {
                continue;
            }

            seen.add(name);
            result.push({ available: isToolAvailable(name), category, name });
        }
    }

    for (const name of Object.keys(ALL_TOOLS) as ToolName[]) {
        if (!seen.has(name)) {
            result.push({ available: isToolAvailable(name), category: "other", name });
        }
    }

    return result;
};
