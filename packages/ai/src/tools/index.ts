/**
 * Application default toolkit categories
 */
export enum AppDefaultToolkit {
    Code = "code",
    Entertainment = "entertainment",
    Finance = "finance",
    Http = "http",
    Location = "location",
    // Scira toolkit categories
    Search = "search",
    Travel = "travel",
    Utility = "utility",
    Visualization = "visualization",
    WebSearch = "webSearch",
}

/**
 * Default tool names available in the application
 */
export enum DefaultToolName {
    // Scira Search Tools
    AcademicSearch = "academicSearch",
    // Scira Finance Tools
    CoinData = "coinData",
    CoinDataByContract = "coinDataByContract",
    CoinOhlc = "coinOhlc",

    CreateBarChart = "createBarChart",
    CreateLineChart = "createLineChart",

    // Visualization tools
    CreatePieChart = "createPieChart",

    CreateTable = "createTable",
    CurrencyConverter = "currencyConverter",

    DateTime = "dateTime",
    // Scira Location Tools
    FindPlace = "findPlace",
    // Scira Travel Tools
    FlightTracker = "flightTracker",
    // HTTP tools
    Http = "http",

    // Code execution tools
    JavascriptExecution = "mini-javascript-execution",

    ListCurrencies = "listCurrencies",
    ListLanguages = "listLanguages",

    // Scira Entertainment Tools
    MovieTvSearch = "movieTvSearch",
    NearbyPlacesSearch = "nearbyPlacesSearch",
    PythonExecution = "python-execution",
    RedditSearch = "redditSearch",
    // Scira Content Tools
    Retrieve = "retrieve",
    StockChart = "stockChart",

    // Scira Language Tools
    TextTranslate = "textTranslate",
    TrendingMovies = "trendingMovies",

    TrendingTv = "trendingTv",

    // Scira Information Tools
    Weather = "weather",
    WebContent = "webContent",
    // Web search tools
    WebSearch = "webSearch",

    XSearch = "xSearch",
    YoutubeSearch = "youtubeSearch",
}

/**
 * Special tool name for sequential thinking
 */
export const SequentialThinkingToolName = "sequential-thinking";

/**
 * Special tool name for image management
 */
export const ImageToolName = "image-manager";
