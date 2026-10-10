import type { LanguageModelV3 } from "@ai-sdk/provider";
import { DEFAULT_CHAT_MODEL } from "@neore/ai/constants";
import { type AgentModeConfig, getComplexTaskPrompt, getSystemPrompt, type SkillMetadata, type TaskType, type UserPersonalization } from "@neore/ai/prompts";
import type { AgentConfig } from "@neore/ai/providers";
import type { AgentModel } from "@neore/ai/providers";
import type { ToolSet } from "ai";

import { api } from "../../_generated/api";
import { Agent } from "../../agent/client";
import type { ServiceFetch } from "../../lib/services.js";
import { type GatewayCustomProviderConfig, GatewayLanguageModel } from "./gateway-language-model.js";

// Lazy singleton — providers are loaded via dynamic import() the first time this
// is called, keeping provider SDKs out of the module-analysis bundle.
let _agentsPromise: Promise<Record<string, AgentConfig>> | undefined;

const getAgents = (): Promise<Record<string, AgentConfig>> => {
    if (!_agentsPromise) {
        _agentsPromise = import("@neore/ai/providers").then(({ buildAgents }) => buildAgents());
    }

    return _agentsPromise;
};

export interface GetAgentOptions {
    /**
     * Agent mode configuration for enhanced task execution
     * Agent loop is always enabled - this controls additional modules:
     * - Planner: Task breakdown and progress tracking
     * - Knowledge: Best practices and domain patterns
     * - Datasource: Data validation and source verification
     */
    agentMode?: AgentModeConfig;

    /**
     * Resolved (decrypted) user endpoint for a `custom:<providerId>/<modelId>`
     * model. Without it a custom id falls back to the default model like any
     * other unknown id.
     */
    customProvider?: GatewayCustomProviderConfig;

    /**
     * Enabled skills metadata for Level 1 progressive disclosure
     * Injected into system prompt for ambient awareness
     */
    enabledSkills?: SkillMetadata[];

    /**
     * The LLM gateway's service binding, from the calling action:
     * `gatewayFetch(ctx)`. REQUIRED, so every caller decides: an agent built in
     * a query or mutation (to read or save messages, never to generate) passes
     * `NO_SERVICE_FETCH`, and `gatewayFetchFor(ctx)` picks for a ctx of any kind.
     */
    gateway: ServiceFetch;

    /**
     * Optional BCP 47 language code (e.g., "en-US", "es-ES") for AI responses
     */
    language?: string;

    /**
     * Optional user location (e.g., "New York, USA", "Berlin, Germany")
     */
    location?: string;

    /**
     * Maximum number of tool execution steps (default: 5)
     */
    maxSteps?: number;

    /**
     * Model filter rules for geographic/compliance/privacy restrictions.
     * Forwarded to the LLM Gateway so it can enforce region/provider/model filtering.
     */
    modelFilterRules?: {
        allowedModels?: string[];
        allowedProviders?: string[];
        allowedRegions?: string[];
        blockedModels?: string[];
        blockedProviders?: string[];
        blockedRegions?: string[];
        denyDataCollection?: boolean;
        requireZDR?: boolean;
    };

    /**
     * Optional model ID override
     */
    modelId?: string;

    /**
     * User personalization settings (nickname, profession, aboutMe, customInstructions)
     */
    personalization?: UserPersonalization;

    /**
     * Optional provider ID override
     */
    providerId?: string;

    /**
     * Current search mode (e.g., "web", "academic", "chat").
     * Passed to the system prompt to enable numbered inline citations in search modes.
     */
    searchMode?: string;

    /**
     * Active skill context for Level 2 (invoked via slash command)
     * Full instructions + config loaded and ready to execute
     */
    skillContext?: {
        config?: {
            additionalTools?: string[];
            disabledTools?: string[];
            preferredModel?: string;
            reasoningEffort?: number;
            searchMode?: string;
        };
        instructions: string;
    };

    /**
     * Optional task context for adaptive prompting (Layer 4)
     * Used when auto-detection identifies a complex task requiring specialized guidance
     */
    taskContext?: {
        requirePlanning: boolean;
        requireValidation: boolean;
        taskType: TaskType;
        userMessage: string;
    };

    /**
     * Thread ID for usage attribution and context.
     */
    threadId?: string;

    /**
     * Optional IANA timezone identifier (e.g., "America/New_York", "Europe/Berlin")
     */
    timezone?: string;

    /**
     * Tools to make available to the agent
     */
    tools?: ToolSet;

    /**
     * User ID for BYOK key resolution and usage attribution.
     */
    userId?: string;

    /**
     * Decrypted user provider API keys for BYOK support.
     * When provided, the model for the requested provider will be instantiated
     * with the user's key instead of the global env var, falling back to the
     * static model if no matching key exists.
     */
    userProviderKeys?: Record<string, string>;
}

const getAgent = async (model: AgentModel | string, options: GetAgentOptions): Promise<Agent> => {
    const agents = await getAgents();
    let agent = agents[model as string];
    let effectiveModel = model as string;
    const { parseCustomModelId } = await import("@neore/ai/models");
    const custom = options?.customProvider ? parseCustomModelId(model as string) : null;

    // A user's own endpoint has no registry entry: borrow the default model's
    // instructions and swap in a gateway model pointed at the endpoint below.
    if (custom && !agent) {
        agent = agents[DEFAULT_CHAT_MODEL];
    }

    // Fallback to default model if the requested model is not available
    // This can happen with archived threads that have old or unavailable models
    if (!agent) {
        const fallbackModel = DEFAULT_CHAT_MODEL;
        const fallbackAgent = agents[fallbackModel];

        if (!fallbackAgent) {
            throw new Error(`Unknown agent model: ${model} and fallback model ${fallbackModel} is also unavailable`);
        }

        // Use fallback agent and model name
        agent = fallbackAgent;
        effectiveModel = fallbackModel;
    }

    const { instructions } = agent;
    let { chat } = agent;

    if (!chat) {
        throw new Error(`Model ${effectiveModel} is not a text model and cannot be used as a chat agent`);
    }

    // LLM Gateway: proxy ALL LLM calls through the gateway for token counting,
    // cost tracking, and usage analytics — over its service binding.
    const { gateway } = options;

    if (custom && options.customProvider) {
        // No platform key. A compatible endpoint is billed `custom` (never
        // charged); a provider-native account (Gemini, Azure, Bedrock, Mistral)
        // is the user's own key and billed `byok` — the gateway decides from
        // `customProvider.format`.
        chat = new GatewayLanguageModel({
            customProvider: options.customProvider,
            gateway,
            modelApiId: custom.modelId,
            modelId: effectiveModel,
            orgId: undefined,
            provider: "custom",
            threadId: options.threadId,
            userId: options.userId,
        }) as unknown as LanguageModelV3;
    } else {
        const { MODEL_REGISTRY } = await import("@neore/ai/models");
        const modelDefinition = MODEL_REGISTRY.find((m) => m.id === effectiveModel);

        if (modelDefinition && modelDefinition.provider !== "external") {
            // Resolve BYOK key if available — pass to gateway instead of instantiating locally
            let providerApiKey: string | undefined;

            if (options?.userProviderKeys) {
                const providerKeyMap: Record<string, string> = {
                    fal: "fal",
                    google: "google",
                    groq: "groq",
                    openai: "openai",
                    openrouter: "openrouter",
                    requesty: "requesty",
                    xai: "xai",
                };
                const keyName = providerKeyMap[modelDefinition.provider];

                if (keyName && options.userProviderKeys[keyName]) {
                    providerApiKey = options.userProviderKeys[keyName];
                }
            }

            chat = new GatewayLanguageModel({
                gateway,
                modelApiId: modelDefinition.modelApiId,
                modelFilterRules: options?.modelFilterRules,
                modelId: effectiveModel,
                orgId: undefined,
                provider: modelDefinition.provider,
                providerApiKey,
                threadId: options?.threadId,
                userId: options?.userId,
            }) as unknown as LanguageModelV3;
        }
    }

    const timezone = options?.timezone;
    const location = options?.location;
    const language = options?.language;
    const personalization = options?.personalization;
    const enabledSkills = options?.enabledSkills;
    const skillContext = options?.skillContext;
    const agentMode = options?.agentMode;
    const searchMode = options?.searchMode;

    // Agent loop is always included in system prompt for systematic task execution
    // Additional modules (Planner, Knowledge, Datasource) are controlled via agentMode
    const systemPrompt =
        timezone || location || language || personalization || enabledSkills || agentMode || searchMode
            ? getSystemPrompt(timezone, location, language, personalization, enabledSkills, agentMode, searchMode)
            : "";

    let finalInstructions = instructions;

    if (systemPrompt && instructions) {
        finalInstructions = `${systemPrompt} ${instructions}`;
    } else if (systemPrompt) {
        finalInstructions = systemPrompt;
    }

    // Layer skill instructions (Level 2) after system prompt if skill is active
    if (skillContext?.instructions) {
        const skillSection = `\n\nACTIVE SKILL:\n${skillContext.instructions}`;

        finalInstructions = finalInstructions ? `${finalInstructions}${skillSection}` : skillContext.instructions;
    }

    // Layer 4: Task-specific prompt enhancement (if complex task detected)
    if (options?.taskContext) {
        const { requirePlanning, requireValidation, taskType, userMessage } = options.taskContext;

        // Only add task-specific prompts for non-general tasks
        if (taskType && taskType !== "general") {
            const taskPrompt = getComplexTaskPrompt(userMessage, taskType, {
                requirePlanning,
                trackProgress: true,
                validateResults: requireValidation,
            });

            finalInstructions = finalInstructions ? `${finalInstructions}\n\n${taskPrompt}` : taskPrompt;
        }
    }

    // `api`, not `api.agent`. Lunora flattens the namespace, so the agent's
    // functions are spread across `api.agent.messages`, `api.agent.threads`, … and
    // the component surface is the whole generated api (see `AgentComponent`).
    return new Agent(api, {
        instructions: finalInstructions,
        languageModel: chat,
        maxSteps: options?.maxSteps ?? 5,
        name: effectiveModel,
        tools: options?.tools,
    });
};

export default getAgent;
