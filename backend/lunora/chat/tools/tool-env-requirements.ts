/**
 * Tool Environment Requirements
 *
 * Single source of truth mapping each tool to the environment variable(s) it requires.
 * Shared by tools/index.ts and tests.
 *
 * Tools not listed here have no external API dependency and are always available.
 */

/**
 * Standard requirements: ALL listed env vars must be set.
 */
export const TOOL_ENV_REQUIREMENTS: Partial<Record<string, string[]>> = {
    academicSearch: ["EXA_API_KEY"],
    // `browser` has no entry: `browser-node.ts` drives the browser-renderer
    // Worker over a service binding (`SERVICE_BROWSER_RENDERER`), which is part
    // of every deploy (`lunora.config.ts`, `alchemy.run.ts`) and is not an env
    // var a check here could read.
    codeExecution: ["E2B_API_KEY"],
    codeSearch: ["EXA_API_KEY"],
    coinData: ["COINGECKO_API_KEY"],
    coinDataByContract: ["COINGECKO_API_KEY"],
    coinOhlc: ["COINGECKO_API_KEY"],
    companySearch: ["TAVILY_API_KEY"],
    currencyConverter: ["VALYU_API_KEY"],
    deepResearch: ["TAVILY_API_KEY"],
    delegateToCodingAgent: ["E2B_API_KEY"],
    fileOperations: ["E2B_API_KEY"],
    findPlace: ["GOOGLE_MAPS_API_KEY"],
    flightTracker: ["AMADEUS_CLIENT_ID", "AMADEUS_CLIENT_SECRET"],
    githubSearch: ["GITHUB_TOKEN"],
    imageEditing: ["FAL_API_KEY"],
    imageGeneration: ["FAL_API_KEY"],
    imageSearch: ["TAVILY_API_KEY"],
    listCurrencies: ["VALYU_API_KEY"],
    movieTvSearch: ["TMDB_API_KEY"],
    nearbyPlacesSearch: ["GOOGLE_MAPS_API_KEY"],
    peopleSearch: ["TAVILY_API_KEY"],
    redditSearch: ["PARALLEL_API_KEY"],
    shellExecution: ["E2B_API_KEY"],
    spotifySearch: ["SPOTIFY_CLIENT_ID", "SPOTIFY_CLIENT_SECRET"],
    stockChart: ["VALYU_API_KEY"],
    trendingMovies: ["TMDB_API_KEY"],
    trendingTv: ["TMDB_API_KEY"],
    videoGeneration: ["FAL_API_KEY"],
    videoSearch: ["TAVILY_API_KEY"],
    weather: ["OPENWEATHER_API_KEY"],
    webSearch: ["TAVILY_API_KEY"],
    wolframAlpha: ["WOLFRAM_APP_ID"],
    xSearch: ["XAI_API_KEY"],
    youtubeSearch: ["SUPADATA_API_KEY"],
};

/**
 * OR-logic requirements: tool is available if ANY group of env vars is fully set.
 * Each entry is an array of alternatives; each alternative is an array of env vars
 * that must all be present for that provider path to work.
 */
export const TOOL_ENV_REQUIREMENTS_OR: Partial<Record<string, string[][]>> = {
    // Retrieve: Exa primary, Firecrawl fallback, or bare fetch (always works)
    retrieve: [["EXA_API_KEY"], ["FIRECRAWL_API_KEY"]],
};

/** Tools that have no external dependency and are always available */
export const ALWAYS_AVAILABLE_TOOLS = [
    "askUser",
    "delegateToSubAgent",
    "dateTime",
    "textTranslate",
    "listLanguages",
    "createDocument",
    "updateDocument",
    "createPresentation",
    "updateSlide",
    "searchMemory",
    "knowledgeSearch",
    "taskList",
    "canvasAI",
    "createDesign",
    "updateDesign",
    "renderUI",
    "visionAnalysis",
    "deepfakeDetection",
];

/**
 * Check if a tool's required env vars are configured.
 * Tools with no requirements are always available.
 */
export const isToolAvailable = (toolName: string): boolean => {
    // Check OR-logic requirements first (multi-provider tools)
    const orRequirements = TOOL_ENV_REQUIREMENTS_OR[toolName];

    if (orRequirements) {
        return orRequirements.some((group) => group.every((envVariable) => !!process.env[envVariable]));
    }

    const requirements = TOOL_ENV_REQUIREMENTS[toolName];

    if (!requirements || requirements.length === 0) {
        return true;
    }

    return requirements.every((envVariable) => !!process.env[envVariable]);
};

/**
 * Get the missing env vars for a tool (for diagnostics).
 * Returns all missing vars across all requirement groups.
 */
export const getMissingEnvVariables = (toolName: string): string[] => {
    const orRequirements = TOOL_ENV_REQUIREMENTS_OR[toolName];

    if (orRequirements) {
        // If tool is available via any path, nothing is "missing"
        if (isToolAvailable(toolName)) return [];

        // Return all unique env vars across all groups that aren't set
        const allVariables = new Set(orRequirements.flat());

        return [...allVariables].filter((envVariable) => !process.env[envVariable]);
    }

    const requirements = TOOL_ENV_REQUIREMENTS[toolName];

    if (!requirements) return [];

    return requirements.filter((envVariable) => !process.env[envVariable]);
};
