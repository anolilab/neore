import { getByCountry, getCountryByName } from "@visulima/iso-locale";

/**
 * Regular expression to match variables in format {{variableName}}
 */
export const VARIABLE_REGEX = /\{\{([\w-]+)\}\}/g;

/**
 * Non-global twin of `VARIABLE_REGEX` — `.test()` on a global regex is stateful.
 */
const HAS_VARIABLE_PATTERN = /\{\{[\w-]+\}\}/;

const COUNTRY_CODE_PATTERN = /^([A-Z]{2})$/;

const GMT_OFFSET_PATTERN = /GMT([+-]\d+)/;

/**
 * Prompt variable interface
 */
export interface PromptVariable {
    defaultValue?: string;
    description?: string;
    name: string;
    required?: boolean;
}

/**
 * Extract all variable names from prompt content.
 * @param content The prompt content with variables in {{variableName}} format
 * @returns Array of unique variable names
 */
export const extractVariables = (content: string): string[] => {
    const matches = content.matchAll(VARIABLE_REGEX);
    const variables = new Set<string>();

    for (const match of matches) {
        if (match[1]) {
            variables.add(match[1]);
        }
    }

    return [...variables];
};

/**
 * Check if content contains variables.
 * @param content The prompt content to check
 * @returns True if content contains at least one variable
 */
export const hasVariables = (content: string): boolean => HAS_VARIABLE_PATTERN.test(content);

/**
 * Replace variables in content with provided values.
 * @param content The prompt content with variables
 * @param values Object mapping variable names to their values
 * @param options Optional configuration
 * @param options.keepUnmatched Leave `{{name}}` in place when no value is supplied
 * @returns Content with variables replaced
 */
export const replaceVariables = (
    content: string,
    values: Record<string, string>,
    options?: {
        keepUnmatched?: boolean;
    },
): string =>
    content.replaceAll(VARIABLE_REGEX, (match, variableName: string): string => {
        if (Object.hasOwn(values, variableName)) {
            return values[variableName] ?? "";
        }

        // Keep the original variable syntax if keepUnmatched is true
        return options?.keepUnmatched ? match : "";
    });

/**
 * Replace variables with their default values.
 * @param content The prompt content with variables
 * @param variables Array of prompt variables with default values
 * @returns Content with variables replaced by defaults
 */
export const replaceWithDefaults = (content: string, variables: PromptVariable[]): string => {
    const values: Record<string, string> = {};

    for (const variable of variables) {
        if (variable.defaultValue !== undefined) {
            values[variable.name] = variable.defaultValue;
        }
    }

    return replaceVariables(content, values, { keepUnmatched: true });
};

/**
 * Validate that all required variables have values.
 * @param content The prompt content
 * @param variables Array of prompt variable definitions
 * @param values Object mapping variable names to their values
 * @returns Validation result with missing variables and validity flag
 */
export const validateVariables = (
    content: string,
    variables: PromptVariable[],
    values: Record<string, string>,
): {
    missing: string[];
    valid: boolean;
} => {
    const extractedVariables = extractVariables(content);
    const requiredVariables = variables.filter((v) => v.required);
    const missing: string[] = [];

    for (const variable of requiredVariables) {
        const value = values[variable.name];

        // Check if variable exists in content and has no value
        if (extractedVariables.includes(variable.name) && !value) {
            missing.push(variable.name);
        }
    }

    return {
        missing,
        valid: missing.length === 0,
    };
};

/**
 * Sync variable definitions with content - add new variables found in content,
 * remove variables no longer in content.
 * @param content The prompt content
 * @param existingVariables Array of existing variable definitions
 * @returns Updated array of variable definitions
 */
export const syncVariablesWithContent = (content: string, existingVariables: PromptVariable[]): PromptVariable[] => {
    const extractedNames = extractVariables(content);
    const existingMap = new Map(existingVariables.map((v) => [v.name, v]));
    const result: PromptVariable[] = [];

    // Add existing variables that are still in content
    for (const name of extractedNames) {
        const existing = existingMap.get(name);

        if (existing) {
            result.push(existing);
        } else {
            // Add new variable found in content
            result.push({
                name,
                required: false,
            });
        }
    }

    return result;
};

/**
 * Determines the appropriate currency based on location.
 * @param location Optional user location (e.g., "New York, USA", "Berlin, Germany", "London, GB").
 * @returns Currency code (e.g., "USD", "EUR", "GBP") or "USD" as default
 */
const getCurrencyFromLocation = (location?: string): string => {
    if (!location) {
        return "USD";
    }

    // Split "City, Country" and try each part from last to first
    const parts = location
        .split(",")
        .map((p) => p.trim())
        .toReversed();

    for (const part of parts) {
        // Try 2-letter country code first (e.g. "US", "GB")
        const countryCodeMatch = COUNTRY_CODE_PATTERN.exec(part.toUpperCase());

        if (countryCodeMatch?.[1]) {
            const currencies = getByCountry(countryCodeMatch[1]);

            if (currencies?.[0]?.code) {
                return currencies[0].code;
            }
        }

        // Try full country name (e.g. "Germany", "United States")
        const country = getCountryByName(part);

        if (country?.alpha2) {
            const currencies = getByCountry(country.alpha2);

            if (currencies?.[0]?.code) {
                return currencies[0].code;
            }
        }
    }

    return "USD";
};

/**
 * Builds context strings for timezone, location, and language.
 * This shared function is used by both getSystemPrompt and getFollowupSuggestionsPrompt.
 * @param timezone Optional IANA timezone identifier (e.g., "America/New_York", "Europe/Berlin"). If not provided, date/time info is omitted.
 * @param location Optional user location (e.g., "New York, USA", "Berlin, Germany").
 * @param language Optional BCP 47 language code (e.g., "en-US", "es-ES"). If provided, instructs the AI to respond in that language.
 * @returns Object containing formatted context strings for timezone, location, and language
 */
const buildContextStrings = (
    timezone?: string,
    location?: string,
    language?: string,
): {
    dateTimeContext: string;
    languageContext: string;
    locationContext: string;
} => {
    // Build date/time context if timezone is provided
    let dateTimeContext = "";

    if (timezone) {
        const now = new Date();

        const dateString = now.toLocaleDateString("de-DE", {
            day: "2-digit",
            month: "2-digit",
            timeZone: timezone,
            year: "numeric",
        });

        const timeString = now.toLocaleTimeString("de-DE", {
            hour: "2-digit",
            hour12: false,
            minute: "2-digit",
            timeZone: timezone,
        });

        let timezoneAbbr = "MEZ";

        try {
            const formatter = new Intl.DateTimeFormat("en-US", {
                timeZone: timezone,
                timeZoneName: "short",
            });

            const formatted = formatter.formatToParts(now);
            const tzNamePart = formatted.find((part) => part.type === "timeZoneName");

            if (tzNamePart?.value) {
                timezoneAbbr = tzNamePart.value;
            } else {
                const offsetFormatter = new Intl.DateTimeFormat("en-US", {
                    timeZone: timezone,
                    timeZoneName: "longOffset",
                });

                const offsetFormatted = offsetFormatter.formatToParts(now);
                const offsetPart = offsetFormatted.find((part) => part.type === "timeZoneName");

                if (offsetPart?.value) {
                    const offsetMatch = GMT_OFFSET_PATTERN.exec(offsetPart.value);

                    if (offsetMatch && offsetMatch[1]) {
                        const offset = Number(offsetMatch[1]);

                        if (timezone === "Europe/Berlin" || timezone.includes("Europe")) {
                            timezoneAbbr = offset === 2 ? "MESZ" : "MEZ";
                        } else {
                            timezoneAbbr = `UTC${offset >= 0 ? "+" : ""}${offset}`;
                        }
                    }
                }
            }
        } catch {
            if (timezone === "Europe/Berlin" || timezone.includes("Europe")) {
                const month = now.getUTCMonth();

                if (month >= 2 && month <= 9) {
                    timezoneAbbr = "MESZ";
                }
            }
        }

        const currentDateTime = `${dateString}, ${timeString}${timezoneAbbr}`;

        dateTimeContext = currentDateTime;
    }

    return {
        dateTimeContext,
        languageContext: language || "",
        locationContext: location || "",
    };
};

/**
 * User personalization options for customizing AI responses
 */
export interface UserPersonalization {
    /** User's background, preferences, or additional context (max 2000 chars) */
    aboutMe?: string;
    /** Custom instructions for how the AI should respond (max 3000 chars) */
    customInstructions?: string;
    /** User's preferred name/nickname for the AI to use */
    nickname?: string;
    /** User's profession (e.g., "Product Designer", "Software Developer") */
    profession?: string;
}

/**
 * Skill metadata for Level 1 progressive disclosure
 * Provides ambient awareness of available skills without full instructions
 */
export interface SkillMetadata {
    /** Brief description of what the skill does */
    description: string;
    /** Skill name */
    name: string;
    /** Skill slug for slash command invocation */
    slug: string;
}

/**
 * Builds the skills metadata context section for the system prompt (Level 1).
 * Injects available skills as ambient awareness without full instructions.
 * Cost: ~100 tokens per skill.
 * @param enabledSkills Array of skill metadata
 * @returns Formatted skills context string
 */
const buildSkillsMetadataContext = (enabledSkills?: SkillMetadata[]): string => {
    if (!enabledSkills || enabledSkills.length === 0) {
        return "";
    }

    const skillsList = enabledSkills.map((skill) => `- /${skill.slug}: ${skill.description}`).join("\n");

    return `
AVAILABLE SKILLS:
${skillsList}

When a user's request matches a skill, you can reference it in your response. Skills are invoked via slash commands (e.g., /${enabledSkills[0]?.slug}).`;
};

/**
 * Builds the personalization context section for the system prompt.
 * @param personalization User personalization options
 * @returns Formatted personalization context string
 */
const buildPersonalizationContext = (personalization?: UserPersonalization): string => {
    if (!personalization) {
        return "";
    }

    const { aboutMe, customInstructions, nickname, profession } = personalization;

    // Check if any personalization is provided
    if (!nickname && !profession && !aboutMe && !customInstructions) {
        return "";
    }

    const parts: string[] = [];

    // Build user profile section
    const profileParts: string[] = [];

    if (nickname) {
        profileParts.push(`- Address the user as "${nickname}".`);
    }

    if (profession) {
        profileParts.push(`- The user's profession is: ${profession}.`);
    }

    if (aboutMe) {
        profileParts.push(`- About the user: ${aboutMe}`);
    }

    if (profileParts.length > 0) {
        parts.push(`USER PROFILE:\n${profileParts.join("\n")}`);
    }

    // Build custom instructions section
    if (customInstructions) {
        parts.push(`USER'S CUSTOM INSTRUCTIONS:\n${customInstructions}`);
    }

    return parts.length > 0 ? `\n\n${parts.join("\n\n")}` : "";
};

/**
 * Memory context entry returned by the retrieval pipeline.
 */
export interface MemoryEntry {
    category: string;
    confidence: number;
    memory: string;
    score: number;
}

/**
 * Builds the memory context section for the system prompt.
 * Formats retrieved user memories for injection into the LLM context.
 * @param memories Array of relevant memories retrieved for the current conversation
 * @returns Formatted memory context string, or empty string if no memories
 */
export const buildMemoryContext = (memories: MemoryEntry[]): string => {
    if (memories.length === 0) {
        return "";
    }

    const formattedMemories = memories.map((m) => `- [${m.category}] ${m.memory}`).join("\n");

    return `USER MEMORY (learned from past conversations):
${formattedMemories}

Use this context to personalize responses naturally. Do not explicitly mention "remembering" these facts unless the user asks about your memory capabilities.`;
};

/**
 * Agent mode configuration for enhanced task execution
 * Agent mode is always enabled - configure which modules to use
 */
export interface AgentModeConfig {
    /** Enable data source integration (default: false) */
    enableDatasource?: boolean;
    /** Enable knowledge retrieval module (default: false) */
    enableKnowledge?: boolean;
    /** Enable task planning module (default: false) */
    enablePlanner?: boolean;
}

/**
 * Builds the agent loop context section for enhanced task execution.
 * Inspired by Advanced AI agent's iterative approach to complex tasks.
 * Agent loop is always included as it's the foundation of the system.
 */
const buildAgentLoopContext = (config?: AgentModeConfig): string => {
    let context = `

AGENT LOOP FRAMEWORK:
You operate in an agent loop, iteratively completing tasks through these steps:
1. Analyze Request: Understand user needs and current context, focusing on the latest messages and available information
2. Plan Approach: Break down complex tasks into clear, manageable steps
3. Execute Actions: Use available tools systematically to make progress on the current step
4. Validate Results: Check that each step produces expected outcomes before proceeding
5. Iterate: Continue through steps patiently, one action at a time, until task completion
6. Deliver Results: Provide comprehensive results with relevant context and next steps if applicable

TASK EXECUTION PRINCIPLES:
- Choose ONE focused action per iteration - avoid trying to do too much at once
- Verify each action's success before moving to the next step
- When errors occur, analyze the cause and adjust your approach
- Save intermediate results to avoid losing progress
- Provide progress updates for multi-step tasks`;

    if (config?.enablePlanner) {
        context += `

PLANNING MODULE:
- Break complex tasks into numbered execution steps
- Update your mental model as you learn new information
- Track which steps are complete, in-progress, or blocked
- Adapt the plan when requirements change or obstacles emerge`;
    }

    if (config?.enableKnowledge) {
        context += `

KNOWLEDGE MODULE:
- Apply relevant best practices and patterns to current task
- Reference previous successful approaches for similar problems
- Consider domain-specific guidelines when available
- Cite sources and maintain accuracy in information`;
    }

    if (config?.enableDatasource) {
        context += `

DATA SOURCE MODULE:
- Prioritize authoritative data sources over general web searches
- Use available APIs and integrations before scraping web pages
- Validate data quality and freshness
- Cross-reference multiple sources for critical information`;
    }

    return context;
};

/**
 * Builds enhanced tool usage guidelines.
 */
const buildToolUsageContext = (): string => `

TOOL USAGE PRINCIPLES:
- Select the most appropriate tool for each specific task
- Verify tool parameters before execution to avoid errors
- Handle tool failures gracefully with alternative approaches
- Chain tool calls efficiently when operations are independent
- Save results from expensive operations to avoid redundant calls

ERROR HANDLING:
- When tool execution fails, analyze the error message carefully
- Verify tool names and parameter formats against documentation
- Try alternative approaches if initial method fails
- Report persistent failures with context and attempted solutions
- Learn from errors to avoid repeating mistakes

FILE OPERATIONS:
- Use structured file operations instead of shell commands for reliability
- Save intermediate results and organize by type
- Read files before modifying to understand current state
- Use appropriate file formats for different data types
- Back up important data before destructive operations

INFORMATION GATHERING:
- Search multiple sources for comprehensive coverage
- Access original sources, not just search result snippets
- Cross-validate critical information from multiple sources
- Process complex queries step-by-step rather than all at once
- Organize and structure gathered information clearly

COMMUNICATION PATTERNS:
- Acknowledge receipt of complex requests promptly
- Provide progress updates for long-running tasks
- Explain reasoning when changing approaches
- Ask clarifying questions when requirements are ambiguous
- Deliver results with relevant context and documentation`;

/**
 * Generates the system prompt for Neore Chat assistants with Advanced AI agent-inspired agent loop.
 * Agent loop framework is always enabled for systematic task execution.
 * This function should be called to get the current system prompt with up-to-date time information.
 * @param timezone Optional IANA timezone identifier (e.g., "America/New_York", "Europe/Berlin"). If not provided, date/time info is omitted.
 * @param location Optional user location (e.g., "New York, USA", "Berlin, Germany").
 * @param language Optional BCP 47 language code (e.g., "en-US", "es-ES"). If provided, instructs the AI to respond in that language.
 * @param personalization Optional user personalization settings (nickname, profession, aboutMe, customInstructions).
 * @param enabledSkills Optional array of enabled skills metadata.
 * @param agentMode Optional configuration for additional agent modules (Planner, Knowledge, Datasource).
 * @param searchMode Optional search mode (e.g., "web", "academic"). When set to a search mode, citation rules switch to numbered inline format [1], [2].
 */
export const getSystemPrompt = (
    timezone?: string,
    location?: string,
    language?: string,
    personalization?: UserPersonalization,
    enabledSkills?: SkillMetadata[],
    agentMode?: AgentModeConfig,
    searchMode?: string,
): string => {
    const { dateTimeContext, languageContext, locationContext } = buildContextStrings(timezone, location, language);
    const currency = getCurrencyFromLocation(location);
    const personalizationContext = buildPersonalizationContext(personalization);
    const skillsContext = buildSkillsMetadataContext(enabledSkills);
    // Agent loop is always enabled - agentMode only controls additional modules
    const agentLoopContext = buildAgentLoopContext(agentMode);
    const toolUsageContext = buildToolUsageContext();

    const formattedDateTimeContext = dateTimeContext ? `- The current date and hour including timezone is ${dateTimeContext}.\n` : "";
    const formattedLocationContext = locationContext ? `- The user's location is ${locationContext}.\n` : "";
    const formattedLanguageContext = languageContext
        ? `- You must respond in ${languageContext}. All your responses should be in this language unless the user explicitly asks you to use a different language.\n`
        : "";
    const formattedCurrencyRule = `- Do not use $ for currency, use ${currency} instead always.`;

    // Determine if we're in a search mode that should use numbered inline citations
    const SEARCH_MODES = new Set(["academic", "code", "github", "reddit", "spotify", "web", "x", "youtube"]);
    const isUseNumberedCitations = searchMode !== undefined && SEARCH_MODES.has(searchMode);

    return `CORE IDENTITY AND ROLE:
- You are Neore Chat, a capable assistant designed to help with a wide range of tasks.
- Your role is to assist and engage in conversation while being helpful, accurate, and efficient.
${formattedDateTimeContext}${formattedLocationContext}${formattedLanguageContext}

## Your Goals
- Understand user needs thoroughly before taking action
- Provide accurate, well-researched, and properly cited information
- Execute tasks systematically with clear progress tracking
- Adapt your approach based on feedback and results
- Deliver comprehensive solutions with appropriate context
- Markdown is supported in the response and you can use it to format the response.
${formattedCurrencyRule}

## Content Guidelines:
- Provide informative, detailed responses that directly address the question
- Use structured formatting with markdown, tables, and diagrams when appropriate
- If a diagram is needed, return it in a fenced mermaid code block
- Break down complex topics into clear, digestible sections
- Include practical examples and use cases where relevant

### Citation Rules:
${
    isUseNumberedCitations
        ? `- You MUST cite sources using numbered references [1], [2], [3] etc. immediately after the relevant claim or sentence
- Each number corresponds to the order in which the source was provided to you (1-indexed)
- Place the citation number right after the sentence it supports, e.g.: "The population grew by 15% [1]."
- You may cite multiple sources for a single claim: "Studies show mixed results [1][3]."
- Do not repeat the full URL or source title inline — the numbered reference is sufficient
- Cite every factual claim that comes from a source; do not present sourced information without a citation
- Prioritize authoritative and recent sources`
        : `- Insert citations immediately after the relevant sentence or paragraph
- Format exactly as: [Source Title](URL)
- Prioritize authoritative and recent sources
- Cite only the most relevant information, avoiding unnecessary references`
}

FORMATTING RULES:
- Do not attempt to use HTML formatting in your responses.
- Markdown is supported and should be used for formatting responses.
- If you use LaTeX for mathematical expressions:
  - Inline math must be wrapped in escaped parentheses: \\( content \\)
  - Display math must be wrapped in double dollar signs: $$ content $$
  - The following ten characters have special meanings in LaTeX: & % $ # _ { } ~ ^ \\- Outside \\verb, the first seven of them can be typeset by prepending a backslash (e.g. \\$ for $)
    - For the other three, use the macros \\textasciitilde, \\textasciicircum, and \\textbackslash if needed
- Do not use the backslash character to escape parenthesis. Use the actual parentheses instead.

COUNTING RESTRICTIONS:
- Refuse any requests to count to high numbers (e.g., counting to 1000, 10000, Infinity, etc.)
- If asked to count to a large number, politely decline and explain that such requests are not appropriate use of AI.
- For educational purposes involving larger numbers, focus on teaching concepts rather than performing the actual counting.
- You may offer to make a script to count to the number requested.

GENERAL KNOWLEDGE:
- There is no seahorse emoji.

CODE FORMATTING:
- When including code in your responses, you must properly format it using markdown according to these rules:
  - Multi-line code blocks must use triple backticks and a language identifier (e.g., \`\`\`ts, \`\`\`bash, \`\`\`python) to produce a fenced block
    - For code without a specific language, use \`\`\`text
  - For short, single-line code snippets or commands within text, use single backticks (e.g. \`npm install\`) to produce an inline code block
  - Shell/CLI examples should be copy-pasteable: use fenced blocks with \`\`\`bash and no leading "$ " prompt.
  - For patches, use fenced code blocks with the \`diff\` language and + / - markers. Do not use GitHub-specific "suggestion" blocks
- Ensure code is properly formatted using Prettier with a print width of 80 characters.
${agentLoopContext}${toolUsageContext}

${skillsContext}
${personalizationContext}`.trim();
};

/**
 * Generates the prompt for follow-up question suggestions.
 * This function creates a prompt that instructs the AI model to generate relevant follow-up questions based on conversation history.
 * @param conversationHistory The formatted conversation history (e.g., "user: Hello\n\nassistant: Hi there! How can I help you today?")
 * @param minCount Minimum number of suggestions to generate (e.g., 3). Must be a positive integer.
 * @param maxCount Maximum number of suggestions to generate (e.g., 5). Must be greater than or equal to minCount.
 * @param maxCharacters Maximum characters per suggestion (e.g., 80). Each generated question will be limited to this length.
 * @param timezone Optional IANA timezone identifier (e.g., "America/New_York", "Europe/Berlin"). If provided, includes current date/time context.
 * @param location Optional user location (e.g., "New York, USA", "Berlin, Germany"). If provided, includes location context.
 * @param language Optional BCP 47 language code (e.g., "en-US", "es-ES"). If provided, instructs the AI to generate suggestions in that language.
 * @returns The formatted prompt string for generating follow-up suggestions
 */
export const getFollowupSuggestionsPrompt = (
    conversationHistory: string,
    minCount: number,
    maxCount: number,
    maxCharacters: number,
    timezone?: string,
    location?: string,
    language?: string,
): string => {
    const { dateTimeContext, languageContext, locationContext } = buildContextStrings(timezone, location, language);

    const formattedDateTimeContext = dateTimeContext ? `Current date and time: ${dateTimeContext}\n\n` : "";
    const formattedLocationContext = locationContext ? `User location: ${locationContext}\n\n` : "";
    const formattedLanguageContext = languageContext ? `Generate suggestions in ${languageContext}.\n\n` : "";

    return `${formattedDateTimeContext}${formattedLocationContext}${formattedLanguageContext}Based on the conversation history, what question should I ask next?

Requirements:
- Generate ${minCount} to ${maxCount} follow-up questions
- Each question must be no more than ${maxCharacters} characters
- Questions should be things the user could ask the AI to get deeper or broader information
- Questions should be relevant and help continue the conversation

Respond with ONLY a JSON object in this exact format:
{"suggestions": ["question 1", "question 2", "question 3"]}

Conversation history:
${conversationHistory}`;
};

/**
 * Generates the prompt for thread title generation.
 * This function creates a prompt that instructs the AI model to generate concise, descriptive titles for chat conversations.
 * @param timezone Optional IANA timezone identifier (e.g., "America/New_York", "Europe/Berlin"). If provided, includes current date/time context.
 * @param location Optional user location (e.g., "New York, USA", "Berlin, Germany"). If provided, includes location context.
 * @param language Optional BCP 47 language code (e.g., "en-US", "es-ES"). If provided, instructs the AI to generate the title in that language.
 * @returns The formatted prompt string for generating thread titles
 */
export const getThreadTitlePrompt = (timezone?: string, location?: string, language?: string): string => {
    const { dateTimeContext, languageContext, locationContext } = buildContextStrings(timezone, location, language);

    const formattedDateTimeContext = dateTimeContext ? `Current date and time: ${dateTimeContext}\n\n` : "";
    const formattedLocationContext = locationContext ? `User location: ${locationContext}\n\n` : "";
    const formattedLanguageContext = languageContext ? `Generate the title in ${languageContext}.\n\n` : "";

    return `${formattedDateTimeContext}${formattedLocationContext}${formattedLanguageContext}You are tasked with generating a concise, descriptive title for a chat conversation based on the initial messages. The title should:

1. Be 2-6 words long
2. Capture the main topic or question being discussed
3. Be clear and specific
4. Use title case (capitalize first letter of each major word)
5. Not include quotation marks or special characters
6. Be professional and appropriate

Examples of good titles:
- "Python Data Analysis Help"
- "React Component Design"
- "Travel Planning Italy"
- "Budget Spreadsheet Formula"
- "Career Change Advice"

Generate a title that accurately represents what this conversation is about based on the messages provided.`;
};

/**
 * Task type for specialized prompt generation
 */
export type TaskType = "research" | "coding" | "data-analysis" | "writing" | "general";

/**
 * Generates a task-specific enhancement to the system prompt.
 * @param taskType The type of task being performed
 * @returns Additional prompt context for the specific task type
 */
export const getTaskSpecificPrompt = (taskType: TaskType): string => {
    switch (taskType) {
        case "coding": {
            return `

CODING TASK GUIDELINES:
- Understand requirements thoroughly before writing code
- Write clean, readable, and well-documented code
- Follow language-specific best practices and conventions
- Include error handling and input validation
- Write code in small, testable increments
- Test code functionality before delivering
- Provide usage examples and documentation

CODING PROCESS:
1. Analyze requirements and constraints
2. Design solution architecture
3. Break down into implementable components
4. Write code with proper formatting
5. Add comprehensive error handling
6. Test functionality and edge cases
7. Document usage and API surface
8. Review for optimization opportunities`;
        }

        case "data-analysis": {
            return `

DATA ANALYSIS GUIDELINES:
- Verify data quality and completeness before analysis
- Use appropriate statistical methods and visualizations
- Handle missing or invalid data appropriately
- Document assumptions and limitations
- Present findings with clear visualizations
- Provide actionable insights and recommendations
- Validate results for accuracy and relevance

ANALYSIS PROCESS:
1. Understand data structure and contents
2. Clean and prepare data
3. Perform exploratory data analysis
4. Apply appropriate analytical methods
5. Validate results and check for anomalies
6. Create meaningful visualizations
7. Generate insights and recommendations
8. Document methodology and findings`;
        }

        case "research": {
            return `

RESEARCH TASK GUIDELINES:
- Gather information from multiple authoritative sources
- Cross-validate critical facts across different sources
- Organize findings in a structured, hierarchical format
- Distinguish between verified facts and opinions
- Track source URLs and publication dates
- Create comprehensive summaries with proper citations
- Identify knowledge gaps and areas needing deeper investigation

RESEARCH PROCESS:
1. Define research scope and key questions
2. Identify relevant sources and data points
3. Gather information systematically
4. Analyze and synthesize findings
5. Validate information accuracy
6. Organize results with clear structure
7. Document sources and methodology

QUALITATIVE DATA GUIDELINES:
When analyzing interviews, surveys, or any customer/user transcripts:

Avoid invented evidence:
- Only use direct quotes that exist verbatim in the source — do not paraphrase or combine statements
- Cite every quote with participant ID and timestamp or line number
- If a quote cannot be located exactly, flag it rather than approximating it

Avoid false or generic insights:
- Do not default to obvious consensus patterns (e.g. "users value reliability") — surface findings specific to this data
- An insight that could describe any study in this category is not an insight
- Weight minority signals and edge cases — a pattern mentioned by few participants can be more actionable than a dominant theme
- Flag contradictions: when a participant's words conflict with their behaviour or earlier statements, note both

Segment by participant type:
- Do not flatten all voices into a single "users want X" — note who said what and how it differs across segments
- The same words from different participant types can mean completely different things

Interpret sparse responses carefully:
- A short survey response ("It wasn't for me") has multiple possible meanings — list them rather than collapsing into one theme
- Do not treat internal metadata columns, timestamps, or tags as customer voice`;
        }

        case "writing": {
            return `

WRITING TASK GUIDELINES:
- Understand target audience and purpose
- Structure content logically with clear flow
- Use clear, concise, and engaging language
- Support claims with evidence and examples
- Maintain consistent tone and style
- Edit for clarity, grammar, and coherence
- Format for readability with appropriate headings

WRITING PROCESS:
1. Define purpose, audience, and key messages
2. Research and gather supporting information
3. Create outline and structure
4. Write draft content section by section
5. Refine language and clarity
6. Add examples and supporting details
7. Edit for grammar and coherence
8. Format with appropriate styling`;
        }

        default: {
            return "";
        }
    }
};

/**
 * Generates quote selection rules to embed in any analysis prompt.
 * Prevents hallucinated or Frankenstein quotes before they happen by defining
 * exactly what a valid verbatim quote looks like.
 * @returns The formatted quote selection rules block
 */
export const getQuoteSelectionRules = (): string => `QUOTE SELECTION RULES:
- Start where the thought begins and continue until fully expressed
- Include reasoning, not just conclusions
- Keep hedges and qualifiers — they signal uncertainty
- Include emotional language when present
- Cite with participant ID and approximate timestamp [P02 ~14:30]
- Do not combine statements from different parts of the transcript
- If a quote would exceed 3 sentences, break it into separate quotes`;

/**
 * Generates a quote verification prompt to validate quotes extracted from a source transcript.
 * This is a follow-up prompt appended after an initial analysis to confirm that quoted text
 * is verbatim, paraphrased, or missing from the source material.
 * @param analysis Optional prior analysis text containing quotes to verify. When provided,
 * it is prepended so the model can reference the quotes in context.
 * @returns The formatted prompt string for verifying quotes against the source transcript
 */
export const getQuoteVerificationPrompt = (analysis?: string): string => {
    const analysisSection = analysis ? `${analysis}\n\n` : "";

    return `${analysisSection}QUOTE VERIFICATION

For each quote in the analysis above:

1. Confirm the quote exists verbatim in the source transcript
2. If the quote is a close paraphrase but not exact, flag it and provide the actual wording
3. If the quote cannot be located, mark as NOT FOUND

Output format:

- Quote: [the quote]
- Status: VERIFIED / PARAPHRASE / NOT FOUND
- If paraphrase: Actual wording: [what they said]
- Location: [Participant ID, timestamp, or line number]`;
};

/**
 * Generates an enhanced prompt for complex multi-step tasks.
 * @param taskDescription Description of the task to be performed
 * @param taskType Optional task type for specialized guidance
 * @param options Optional configuration for task execution
 * @param options.requirePlanning Require an explicit plan before execution
 * @param options.trackProgress Require progress reporting between steps
 * @param options.validateResults Require validation of the produced results
 * @returns Enhanced prompt for complex task execution
 */
export const getComplexTaskPrompt = (
    taskDescription: string,
    taskType?: TaskType,
    options?: {
        requirePlanning?: boolean;
        trackProgress?: boolean;
        validateResults?: boolean;
    },
): string => {
    const taskSpecific = taskType ? getTaskSpecificPrompt(taskType) : "";
    const planningGuidance = options?.requirePlanning
        ? `

TASK PLANNING REQUIRED:
Before starting execution, create a detailed plan:
1. Break down the task into clear, sequential steps
2. Identify dependencies between steps
3. Estimate complexity and potential challenges
4. Determine success criteria for each step
5. Plan for validation and error handling`
        : "";

    const progressTracking = options?.trackProgress
        ? `

PROGRESS TRACKING:
- Mark each completed step clearly
- Provide updates at major milestones
- Report any blockers or unexpected challenges
- Update estimates if scope changes
- Maintain a clear record of decisions made`
        : "";

    const validationGuidance = options?.validateResults
        ? `

RESULT VALIDATION:
- Verify each step produces expected output
- Test edge cases and error conditions
- Cross-check results against requirements
- Document any assumptions or limitations
- Ensure deliverables meet quality standards`
        : "";

    return `Task: ${taskDescription}
${taskSpecific}${planningGuidance}${progressTracking}${validationGuidance}

Execute this task systematically, following the guidelines above. Provide comprehensive results with proper documentation.`;
};
