/**
 * JIT (Just-In-Time) Tool Loading
 *
 * Dynamically loads tools based on skill configuration at execution time.
 * Instead of loading all tools upfront (which wastes memory and token budget),
 * this module resolves only the tools a skill needs.
 *
 * Architecture:
 * - Skills define `config.additionalTools` and `config.disabledTools`
 * - At execution time, the tool registry is filtered based on these configs
 * - Tool metadata (name + description) is available cheaply for system prompts
 * - Full tool implementations are loaded only when actually invoked
 *
 * This reduces:
 * - System prompt token count (fewer tool descriptions)
 * - Memory usage (fewer loaded tool implementations)
 * - Latency (less schema serialization overhead)
 */
import { v } from "lunorash/server";

import { internalQuery } from "../_generated/server";

/**
 * Tool descriptor — lightweight metadata used for system prompt injection.
 */
export interface ToolDescriptor {
    category: string;
    description: string;
    name: string;
}

/**
 * All available tools in the system with their categories.
 * This is the canonical tool registry — tools are referenced by name.
 */
const TOOL_REGISTRY: ToolDescriptor[] = [
    { category: "search", description: "Search the web for information", name: "webSearch" },
    { category: "search", description: "Search academic papers and publications", name: "academicSearch" },
    { category: "search", description: "Search code repositories", name: "codeSearch" },
    { category: "search", description: "Search for images", name: "imageSearch" },
    { category: "search", description: "Search for videos", name: "videoSearch" },
    { category: "search", description: "Search GitHub repos, issues, PRs", name: "githubSearch" },
    { category: "search", description: "Search Reddit posts and comments", name: "redditSearch" },
    { category: "search", description: "Search X/Twitter posts", name: "xSearch" },
    { category: "search", description: "Search YouTube videos", name: "youtubeSearch" },
    { category: "knowledge", description: "Search user's knowledge base", name: "knowledgeSearch" },
    { category: "knowledge", description: "Search user's memories", name: "searchMemory" },
    { category: "creation", description: "Create a text document artifact", name: "createDocument" },
    { category: "creation", description: "Update an existing document", name: "updateDocument" },
    { category: "creation", description: "Create a design canvas", name: "createDesign" },
    { category: "creation", description: "Update a design canvas", name: "updateDesign" },
    { category: "creation", description: "Create a slide presentation", name: "createPresentation" },
    { category: "creation", description: "Generate images from text prompts", name: "imageGeneration" },
    { category: "creation", description: "Generate videos from prompts", name: "videoGeneration" },
    { category: "code", description: "Execute shell commands in sandbox", name: "shellExecution" },
    { category: "code", description: "Execute Python code in sandbox", name: "codeExecution" },
    { category: "code", description: "Read/write/edit files in sandbox", name: "fileOperations" },
    { category: "automation", description: "Browse the web with Playwright", name: "browser" },
    { category: "analysis", description: "Analyze images for AI manipulation", name: "deepfakeDetection" },
    { category: "analysis", description: "Analyze image content", name: "visionAnalysis" },
    { category: "utility", description: "Get weather information", name: "weather" },
    { category: "utility", description: "Get current date/time", name: "datetime" },
    { category: "utility", description: "Convert between currencies", name: "currencyConverter" },
    { category: "utility", description: "Translate text between languages", name: "textTranslate" },
    { category: "utility", description: "Compute with Wolfram Alpha", name: "wolframAlpha" },
    { category: "research", description: "Conduct deep multi-step research", name: "deepResearch" },
    { category: "productivity", description: "Manage task lists", name: "taskList" },
    { category: "meta", description: "Create a new AI agent", name: "createAgent" },
];

/**
 * Resolve which tools a skill should have access to.
 * @param config Skill's tool configuration
 * @param baseTools Default tool set for the current mode
 * @returns Filtered list of tool names
 */
export const resolveToolSet = (
    config?: {
        additionalTools?: string[];
        disabledTools?: string[];
    },
    baseTools?: string[],
): string[] => {
    // Start with base tools or all tools
    let toolNames = baseTools ? [...baseTools] : TOOL_REGISTRY.map((t) => t.name);

    // Add additional tools
    if (config?.additionalTools) {
        const validAdditional = config.additionalTools.filter((name) => TOOL_REGISTRY.some((t) => t.name === name));

        toolNames = [...new Set([...toolNames, ...validAdditional])];
    }

    // Remove disabled tools
    if (config?.disabledTools) {
        const disabledSet = new Set(config.disabledTools);

        toolNames = toolNames.filter((name) => !disabledSet.has(name));
    }

    return toolNames;
};

/**
 * Get tool descriptors for a resolved tool set.
 * Used for injecting tool metadata into system prompts.
 */
export const getToolDescriptors = (toolNames: string[]): ToolDescriptor[] => {
    const nameSet = new Set(toolNames);

    return TOOL_REGISTRY.filter((t) => nameSet.has(t.name));
};

/**
 * Every tool descriptor tagged with `category`, for the just-in-time loader's
 * category filter. Unknown categories yield an empty array rather than throwing —
 * the category string arrives from a model.
 */
export const getToolsByCategory = (category: string): ToolDescriptor[] => TOOL_REGISTRY.filter((t) => t.category === category);

/**
 * Get the full tool registry.
 */
export const getToolRegistry = (): ToolDescriptor[] => [...TOOL_REGISTRY];

/**
 * `preferredModel` / `searchMode` are `v.optional(v.string())` on the `skills`
 * table's `config` column, so they are optional here too — the handler forwards
 * them verbatim and they are absent whenever the skill did not set them.
 */
export const getSkillToolConfig = internalQuery
    .input({
        skillId: v.id("skills"),
    })
    .output(
        v.union(
            v.null(),
            v.object({
                preferredModel: v.optional(v.string()),
                searchMode: v.optional(v.string()),
                tools: v.array(v.string()),
            }),
        ),
    )
    .query(async ({ args: { skillId }, ctx }) => {
        const skill = await ctx.db.skills.findFirst({ where: { _id: skillId } });

        if (!skill) {
            return null;
        }

        const resolvedTools = resolveToolSet(skill.config);

        return {
            preferredModel: skill.config?.preferredModel,
            searchMode: skill.config?.searchMode,
            tools: resolvedTools,
        };
    });
