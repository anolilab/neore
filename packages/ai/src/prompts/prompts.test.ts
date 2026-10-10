import { describe, expect, it } from "vitest";

import type { AgentModeConfig, PromptVariable, SkillMetadata, TaskType, UserPersonalization } from "./index";
import {
    extractVariables,
    getComplexTaskPrompt,
    getFollowupSuggestionsPrompt,
    getQuoteSelectionRules,
    getQuoteVerificationPrompt,
    getSystemPrompt,
    getTaskSpecificPrompt,
    getThreadTitlePrompt,
    hasVariables,
    replaceVariables,
    replaceWithDefaults,
    syncVariablesWithContent,
    validateVariables,
} from "./index";

describe("Prompt System Tests", () => {
    // =========================================================================
    // Variable Helper Functions
    // =========================================================================

    describe("extractVariables", () => {
        it("should extract variables from content", () => {
            const content = "Hello {{name}}, your {{role}} is {{status}}";
            const variables = extractVariables(content);

            expect(variables).toEqual(["name", "role", "status"]);
        });

        it("should extract unique variables only", () => {
            const content = "{{name}} and {{name}} and {{email}}";
            const variables = extractVariables(content);

            expect(variables).toEqual(["name", "email"]);
        });

        it("should return empty array for no variables", () => {
            const content = "No variables here";
            const variables = extractVariables(content);

            expect(variables).toEqual([]);
        });

        it("should handle empty string", () => {
            const variables = extractVariables("");

            expect(variables).toEqual([]);
        });
    });

    describe("hasVariables", () => {
        it("should return true when variables exist", () => {
            expect(hasVariables("Hello {{name}}")).toBe(true);
        });

        it("should return false when no variables exist", () => {
            expect(hasVariables("Hello world")).toBe(false);
        });

        it("should return false for empty string", () => {
            expect(hasVariables("")).toBe(false);
        });
    });

    describe("replaceVariables", () => {
        it("should replace variables with values", () => {
            const content = "Hello {{name}}, you are {{age}} years old";
            const values = { age: "25", name: "Alice" };
            const result = replaceVariables(content, values);

            expect(result).toBe("Hello Alice, you are 25 years old");
        });

        it("should remove unmatched variables by default", () => {
            const content = "Hello {{name}}, you are {{age}}";
            const values = { name: "Alice" };
            const result = replaceVariables(content, values);

            expect(result).toBe("Hello Alice, you are ");
        });

        it("should keep unmatched variables when keepUnmatched is true", () => {
            const content = "Hello {{name}}, you are {{age}}";
            const values = { name: "Alice" };
            const result = replaceVariables(content, values, { keepUnmatched: true });

            expect(result).toBe("Hello Alice, you are {{age}}");
        });

        it("should handle empty values object", () => {
            const content = "Hello {{name}}";
            const result = replaceVariables(content, {});

            expect(result).toBe("Hello ");
        });
    });

    describe("replaceWithDefaults", () => {
        it("should replace variables with default values", () => {
            const content = "Hello {{name}}, your role is {{role}}";
            const variables: PromptVariable[] = [
                { defaultValue: "Guest", name: "name" },
                { defaultValue: "User", name: "role" },
            ];
            const result = replaceWithDefaults(content, variables);

            expect(result).toBe("Hello Guest, your role is User");
        });

        it("should keep variables without defaults", () => {
            const content = "Hello {{name}}, your role is {{role}}";
            const variables: PromptVariable[] = [{ defaultValue: "Guest", name: "name" }, { name: "role" }];
            const result = replaceWithDefaults(content, variables);

            expect(result).toBe("Hello Guest, your role is {{role}}");
        });
    });

    describe("validateVariables", () => {
        it("should validate that required variables have values", () => {
            const content = "Hello {{name}}, your role is {{role}}";
            const variables: PromptVariable[] = [
                { name: "name", required: true },
                { name: "role", required: true },
            ];
            const values = { name: "Alice", role: "Admin" };
            const result = validateVariables(content, variables, values);

            expect(result.valid).toBe(true);
            expect(result.missing).toEqual([]);
        });

        it("should detect missing required variables", () => {
            const content = "Hello {{name}}, your role is {{role}}";
            const variables: PromptVariable[] = [
                { name: "name", required: true },
                { name: "role", required: true },
            ];
            const values = { name: "Alice" };
            const result = validateVariables(content, variables, values);

            expect(result.valid).toBe(false);
            expect(result.missing).toEqual(["role"]);
        });

        it("should ignore non-required variables", () => {
            const content = "Hello {{name}}, your role is {{role}}";
            const variables: PromptVariable[] = [
                { name: "name", required: true },
                { name: "role", required: false },
            ];
            const values = { name: "Alice" };
            const result = validateVariables(content, variables, values);

            expect(result.valid).toBe(true);
        });
    });

    describe("syncVariablesWithContent", () => {
        it("should add new variables from content", () => {
            const content = "Hello {{name}}, {{email}}";
            const existing: PromptVariable[] = [{ name: "name", required: true }];
            const result = syncVariablesWithContent(content, existing);

            expect(result).toHaveLength(2);
            expect(result[0]?.name).toBe("name");
            expect(result[1]?.name).toBe("email");
        });

        it("should remove variables not in content", () => {
            const content = "Hello {{name}}";
            const existing: PromptVariable[] = [
                { name: "name", required: true },
                { name: "removed", required: false },
            ];
            const result = syncVariablesWithContent(content, existing);

            expect(result).toHaveLength(1);
            expect(result[0]?.name).toBe("name");
        });

        it("should preserve existing variable properties", () => {
            const content = "Hello {{name}}";
            const existing: PromptVariable[] = [{ defaultValue: "Guest", description: "User name", name: "name", required: true }];
            const result = syncVariablesWithContent(content, existing);

            expect(result[0]).toEqual({ defaultValue: "Guest", description: "User name", name: "name", required: true });
        });
    });

    // =========================================================================
    // getSystemPrompt Tests
    // =========================================================================

    describe("getSystemPrompt", () => {
        it("should generate basic system prompt without parameters", () => {
            const prompt = getSystemPrompt();

            expect(prompt).toContain("CORE IDENTITY AND ROLE");
            expect(prompt).toContain("Neore Chat");
            expect(prompt).toContain("AGENT LOOP FRAMEWORK");
            expect(prompt).toContain("TOOL USAGE PRINCIPLES");
        });

        it("should always include agent loop framework", () => {
            const prompt = getSystemPrompt();

            expect(prompt).toContain("AGENT LOOP FRAMEWORK");
            expect(prompt).toContain("Analyze Request");
            expect(prompt).toContain("Plan Approach");
            expect(prompt).toContain("Execute Actions");
            expect(prompt).toContain("Validate Results");
            expect(prompt).toContain("Iterate");
        });

        it("should include timezone and location when provided", () => {
            const prompt = getSystemPrompt("America/New_York", "New York, USA");

            expect(prompt).toContain("New York, USA");
            expect(prompt).toContain("The current date and hour");
        });

        it("should include language instructions when provided", () => {
            const prompt = getSystemPrompt(undefined, undefined, "es-ES");

            expect(prompt).toContain("You must respond in es-ES");
        });

        it("should include personalization when provided", () => {
            const personalization: UserPersonalization = {
                aboutMe: "I love TypeScript",
                customInstructions: "Always use strict mode",
                nickname: "Alice",
                profession: "Developer",
            };
            const prompt = getSystemPrompt(undefined, undefined, undefined, personalization);

            expect(prompt).toContain("Alice");
            expect(prompt).toContain("Developer");
            expect(prompt).toContain("I love TypeScript");
            expect(prompt).toContain("Always use strict mode");
        });

        it("should include skills metadata when provided", () => {
            // Slugs are emitted verbatim, and that is the point: the prompt is
            // telling the model the exact slash command to produce, so anything
            // other than the stored slug would name a skill that does not
            // resolve. The fixture therefore uses real slugs — the backend
            // validates them against /^[a-z0-9]+(?:-[a-z0-9]+)*$/
            // (`skills/validators.ts`), so a camelCase slug like `deepResearch`
            // is rejected at creation and cannot reach this function.
            const skills: SkillMetadata[] = [
                { description: "Comprehensive research tool", name: "Deep Research", slug: "deep-research" },
                { description: "Analyze code structure", name: "Code Analysis", slug: "code-analysis" },
            ];
            const prompt = getSystemPrompt(undefined, undefined, undefined, undefined, skills);

            expect(prompt).toContain("AVAILABLE SKILLS");
            expect(prompt).toContain("/deep-research");
            expect(prompt).toContain("/code-analysis");
        });

        it("should not include agent modules when not configured", () => {
            const prompt = getSystemPrompt();

            expect(prompt).not.toContain("PLANNING MODULE");
            expect(prompt).not.toContain("KNOWLEDGE MODULE");
            expect(prompt).not.toContain("DATA SOURCE MODULE");
        });

        it("should include planner module when enabled", () => {
            const agentMode: AgentModeConfig = { enablePlanner: true };
            const prompt = getSystemPrompt(undefined, undefined, undefined, undefined, undefined, agentMode);

            expect(prompt).toContain("PLANNING MODULE");
            expect(prompt).toContain("Break complex tasks into numbered execution steps");
        });

        it("should include knowledge module when enabled", () => {
            const agentMode: AgentModeConfig = { enableKnowledge: true };
            const prompt = getSystemPrompt(undefined, undefined, undefined, undefined, undefined, agentMode);

            expect(prompt).toContain("KNOWLEDGE MODULE");
            expect(prompt).toContain("Apply relevant best practices");
        });

        it("should include datasource module when enabled", () => {
            const agentMode: AgentModeConfig = { enableDatasource: true };
            const prompt = getSystemPrompt(undefined, undefined, undefined, undefined, undefined, agentMode);

            expect(prompt).toContain("DATA SOURCE MODULE");
            expect(prompt).toContain("Prioritize authoritative data sources");
        });

        it("should include all modules when fully configured", () => {
            const agentMode: AgentModeConfig = {
                enableDatasource: true,
                enableKnowledge: true,
                enablePlanner: true,
            };
            const prompt = getSystemPrompt(undefined, undefined, undefined, undefined, undefined, agentMode);

            expect(prompt).toContain("PLANNING MODULE");
            expect(prompt).toContain("KNOWLEDGE MODULE");
            expect(prompt).toContain("DATA SOURCE MODULE");
        });

        it("should use correct currency based on location", () => {
            const promptUS = getSystemPrompt(undefined, "New York, USA");

            expect(promptUS).toContain("use USD instead always");

            const promptEU = getSystemPrompt(undefined, "Berlin, Germany");

            expect(promptEU).toContain("use EUR instead always");
        });

        it("should handle partial personalization", () => {
            const personalization: UserPersonalization = {
                nickname: "Bob",
            };
            const prompt = getSystemPrompt(undefined, undefined, undefined, personalization);

            expect(prompt).toContain("Bob");
            expect(prompt).not.toContain("profession");
        });

        it("should generate consistent output for same inputs", () => {
            const prompt1 = getSystemPrompt("America/New_York", "New York, USA", "en-US");
            const prompt2 = getSystemPrompt("America/New_York", "New York, USA", "en-US");

            // Note: Prompts include current time, so we just check structure
            expect(prompt1).toContain("CORE IDENTITY");
            expect(prompt2).toContain("CORE IDENTITY");
        });
    });

    // =========================================================================
    // getFollowupSuggestionsPrompt Tests
    // =========================================================================

    describe("getFollowupSuggestionsPrompt", () => {
        it("should generate followup suggestions prompt", () => {
            const history = "user: Hello\nassistant: Hi there!";
            const prompt = getFollowupSuggestionsPrompt(history, 3, 5, 80);

            expect(prompt).toContain("Based on the conversation history");
            expect(prompt).toContain("3 to 5 follow-up questions");
            expect(prompt).toContain("no more than 80 characters");
            expect(prompt).toContain(history);
        });

        it("should include timezone when provided", () => {
            const prompt = getFollowupSuggestionsPrompt("history", 3, 5, 80, "America/New_York");

            expect(prompt).toContain("Current date and time");
        });

        it("should include location when provided", () => {
            const prompt = getFollowupSuggestionsPrompt("history", 3, 5, 80, undefined, "New York, USA");

            expect(prompt).toContain("User location: New York, USA");
        });

        it("should include language instructions when provided", () => {
            const prompt = getFollowupSuggestionsPrompt("history", 3, 5, 80, undefined, undefined, "es-ES");

            expect(prompt).toContain("Generate suggestions in es-ES");
        });

        it("should handle different min/max counts", () => {
            const prompt = getFollowupSuggestionsPrompt("history", 2, 10, 100);

            expect(prompt).toContain("2 to 10 follow-up questions");
            expect(prompt).toContain("no more than 100 characters");
        });
    });

    // =========================================================================
    // getThreadTitlePrompt Tests
    // =========================================================================

    describe("getThreadTitlePrompt", () => {
        it("should generate thread title prompt", () => {
            const prompt = getThreadTitlePrompt();

            expect(prompt).toContain("generating a concise, descriptive title");
            expect(prompt).toContain("2-6 words long");
            expect(prompt).toContain("title case");
        });

        it("should include timezone when provided", () => {
            const prompt = getThreadTitlePrompt("America/New_York");

            expect(prompt).toContain("Current date and time");
        });

        it("should include location when provided", () => {
            const prompt = getThreadTitlePrompt(undefined, "Berlin, Germany");

            expect(prompt).toContain("User location: Berlin, Germany");
        });

        it("should include language instructions when provided", () => {
            const prompt = getThreadTitlePrompt(undefined, undefined, "de-DE");

            expect(prompt).toContain("Generate the title in de-DE");
        });

        it("should include examples", () => {
            const prompt = getThreadTitlePrompt();

            expect(prompt).toContain("Python Data Analysis Help");
            expect(prompt).toContain("React Component Design");
        });
    });

    // =========================================================================
    // getTaskSpecificPrompt Tests
    // =========================================================================

    describe("getTaskSpecificPrompt", () => {
        it("should generate research task prompt", () => {
            const prompt = getTaskSpecificPrompt("research");

            expect(prompt).toContain("RESEARCH TASK GUIDELINES");
            expect(prompt).toContain("Gather information from multiple authoritative sources");
            expect(prompt).toContain("RESEARCH PROCESS");
        });

        it("should include qualitative data guidelines", () => {
            const prompt = getTaskSpecificPrompt("research");

            expect(prompt).toContain("QUALITATIVE DATA GUIDELINES");
            expect(prompt).toContain("verbatim in the source");
            expect(prompt).toContain("Flag contradictions");
            expect(prompt).toContain("Segment by participant type");
            expect(prompt).toContain("sparse responses");
        });

        it("should warn against generic insights", () => {
            const prompt = getTaskSpecificPrompt("research");

            expect(prompt).toContain("any study in this category is not an insight");
        });

        it("should generate coding task prompt", () => {
            const prompt = getTaskSpecificPrompt("coding");

            expect(prompt).toContain("CODING TASK GUIDELINES");
            expect(prompt).toContain("Write clean, readable, and well-documented code");
            expect(prompt).toContain("CODING PROCESS");
        });

        it("should generate data-analysis task prompt", () => {
            const prompt = getTaskSpecificPrompt("data-analysis");

            expect(prompt).toContain("DATA ANALYSIS GUIDELINES");
            expect(prompt).toContain("Verify data quality and completeness");
            expect(prompt).toContain("ANALYSIS PROCESS");
        });

        it("should generate writing task prompt", () => {
            const prompt = getTaskSpecificPrompt("writing");

            expect(prompt).toContain("WRITING TASK GUIDELINES");
            expect(prompt).toContain("Understand target audience and purpose");
            expect(prompt).toContain("WRITING PROCESS");
        });

        it("should return empty string for general task type", () => {
            const prompt = getTaskSpecificPrompt("general");

            expect(prompt).toBe("");
        });

        it("should return empty string for invalid task type", () => {
            const prompt = getTaskSpecificPrompt("invalid" as TaskType);

            expect(prompt).toBe("");
        });
    });

    // =========================================================================
    // getComplexTaskPrompt Tests
    // =========================================================================

    describe("getComplexTaskPrompt", () => {
        it("should generate basic complex task prompt", () => {
            const prompt = getComplexTaskPrompt("Build authentication system");

            expect(prompt).toContain("Task: Build authentication system");
        });

        it("should include task-specific guidelines when taskType provided", () => {
            const prompt = getComplexTaskPrompt("Build API", "coding");

            expect(prompt).toContain("Task: Build API");
            expect(prompt).toContain("CODING TASK GUIDELINES");
        });

        it("should include planning guidance when requirePlanning is true", () => {
            const prompt = getComplexTaskPrompt("Complex task", undefined, { requirePlanning: true });

            expect(prompt).toContain("TASK PLANNING REQUIRED");
            expect(prompt).toContain("Break down the task into clear, sequential steps");
        });

        it("should include progress tracking when trackProgress is true", () => {
            const prompt = getComplexTaskPrompt("Complex task", undefined, { trackProgress: true });

            expect(prompt).toContain("PROGRESS TRACKING");
            expect(prompt).toContain("Mark each completed step clearly");
        });

        it("should include validation guidance when validateResults is true", () => {
            const prompt = getComplexTaskPrompt("Complex task", undefined, { validateResults: true });

            expect(prompt).toContain("RESULT VALIDATION");
            expect(prompt).toContain("Verify each step produces expected output");
        });

        it("should combine all options when provided", () => {
            const prompt = getComplexTaskPrompt("Build auth system", "coding", {
                requirePlanning: true,
                trackProgress: true,
                validateResults: true,
            });

            expect(prompt).toContain("Task: Build auth system");
            expect(prompt).toContain("CODING TASK GUIDELINES");
            expect(prompt).toContain("TASK PLANNING REQUIRED");
            expect(prompt).toContain("PROGRESS TRACKING");
            expect(prompt).toContain("RESULT VALIDATION");
        });

        it("should work with research task type", () => {
            const prompt = getComplexTaskPrompt("Research AI trends", "research", {
                requirePlanning: true,
                validateResults: true,
            });

            expect(prompt).toContain("RESEARCH TASK GUIDELINES");
            expect(prompt).toContain("TASK PLANNING REQUIRED");
            expect(prompt).toContain("RESULT VALIDATION");
        });

        it("should handle no options provided", () => {
            const prompt = getComplexTaskPrompt("Simple task");

            expect(prompt).toContain("Task: Simple task");
            expect(prompt).not.toContain("TASK PLANNING REQUIRED");
            expect(prompt).not.toContain("PROGRESS TRACKING");
            expect(prompt).not.toContain("RESULT VALIDATION");
        });

        it("should handle empty options object", () => {
            const prompt = getComplexTaskPrompt("Task", undefined, {});

            expect(prompt).toContain("Task: Task");
        });
    });

    // =========================================================================
    // getQuoteSelectionRules Tests
    // =========================================================================

    describe("getQuoteSelectionRules", () => {
        it("should include all core selection rules", () => {
            const rules = getQuoteSelectionRules();

            expect(rules).toContain("QUOTE SELECTION RULES");
            expect(rules).toContain("Start where the thought begins");
            expect(rules).toContain("Include reasoning, not just conclusions");
            expect(rules).toContain("hedges and qualifiers");
            expect(rules).toContain("emotional language");
            expect(rules).toContain("participant ID and approximate timestamp");
            expect(rules).toContain("Do not combine statements");
            expect(rules).toContain("3 sentences");
        });

        it("should include citation format example", () => {
            const rules = getQuoteSelectionRules();

            expect(rules).toContain("[P02 ~14:30]");
        });
    });

    // =========================================================================
    // getQuoteVerificationPrompt Tests
    // =========================================================================

    describe("getQuoteVerificationPrompt", () => {
        it("should generate the quote verification prompt without analysis", () => {
            const prompt = getQuoteVerificationPrompt();

            expect(prompt).toContain("QUOTE VERIFICATION");
            expect(prompt).toContain("Confirm the quote exists verbatim in the source transcript");
            expect(prompt).toContain("close paraphrase but not exact");
            expect(prompt).toContain("NOT FOUND");
        });

        it("should include all three verification rules", () => {
            const prompt = getQuoteVerificationPrompt();

            expect(prompt).toContain("1. Confirm the quote exists verbatim");
            expect(prompt).toContain("2. If the quote is a close paraphrase");
            expect(prompt).toContain("3. If the quote cannot be located");
        });

        it("should include the correct output format", () => {
            const prompt = getQuoteVerificationPrompt();

            expect(prompt).toContain("- Quote: [the quote]");
            expect(prompt).toContain("- Status: VERIFIED / PARAPHRASE / NOT FOUND");
            expect(prompt).toContain("- If paraphrase: Actual wording: [what they said]");
            expect(prompt).toContain("- Location: [Participant ID, timestamp, or line number]");
        });

        it("should prepend the analysis when provided", () => {
            const analysis = 'The participant said: "I feel overwhelmed by the workload."';
            const prompt = getQuoteVerificationPrompt(analysis);

            expect(prompt.startsWith(analysis)).toBe(true);
            expect(prompt).toContain("QUOTE VERIFICATION");
        });

        it("should work without analysis argument", () => {
            const prompt = getQuoteVerificationPrompt();

            expect(prompt.startsWith("QUOTE VERIFICATION")).toBe(true);
        });

        it("should separate analysis from verification block with blank line", () => {
            const analysis = "Sample analysis text.";
            const prompt = getQuoteVerificationPrompt(analysis);

            expect(prompt).toContain(`${analysis}\n\nQUOTE VERIFICATION`);
        });
    });

    // =========================================================================
    // Integration Tests
    // =========================================================================

    describe("Integration Tests", () => {
        it("should combine system prompt with complex task prompt", () => {
            const systemPrompt = getSystemPrompt("America/New_York", "New York, USA", "en-US", undefined, undefined, {
                enableKnowledge: true,
                enablePlanner: true,
            });

            const taskPrompt = getComplexTaskPrompt("Build OAuth system", "coding", {
                requirePlanning: true,
                validateResults: true,
            });

            const fullPrompt = `${systemPrompt}\n\n${taskPrompt}`;

            expect(fullPrompt).toContain("CORE IDENTITY");
            expect(fullPrompt).toContain("AGENT LOOP FRAMEWORK");
            expect(fullPrompt).toContain("PLANNING MODULE");
            expect(fullPrompt).toContain("KNOWLEDGE MODULE");
            expect(fullPrompt).toContain("Task: Build OAuth system");
            expect(fullPrompt).toContain("CODING TASK GUIDELINES");
        });

        it("should layer all prompt components correctly", () => {
            const personalization: UserPersonalization = {
                nickname: "Dev",
                profession: "Software Engineer",
            };

            const skills: SkillMetadata[] = [{ description: "Review code quality", name: "Code Review", slug: "code-review" }];

            const agentMode: AgentModeConfig = {
                enableDatasource: false,
                enableKnowledge: true,
                enablePlanner: true,
            };

            const prompt = getSystemPrompt("Europe/Berlin", "Berlin, Germany", "de-DE", personalization, skills, agentMode);

            // Layer 1: Base system prompt
            expect(prompt).toContain("CORE IDENTITY");
            expect(prompt).toContain("AGENT LOOP FRAMEWORK");

            // Layer 2: Agent modules
            expect(prompt).toContain("PLANNING MODULE");
            expect(prompt).toContain("KNOWLEDGE MODULE");
            expect(prompt).not.toContain("DATA SOURCE MODULE");

            // Personalization
            expect(prompt).toContain("Dev");
            expect(prompt).toContain("Software Engineer");

            // Skills
            expect(prompt).toContain("/code-review");

            // Location/Language
            expect(prompt).toContain("Berlin, Germany");
            expect(prompt).toContain("You must respond in de-DE");
        });
    });

    // =========================================================================
    // Edge Cases and Error Handling
    // =========================================================================

    describe("Edge Cases", () => {
        it("should handle undefined values gracefully", () => {
            expect(() => getSystemPrompt(undefined, undefined, undefined, undefined, undefined, undefined)).not.toThrow();
        });

        it("should handle empty strings", () => {
            expect(() => getSystemPrompt("", "", "")).not.toThrow();
        });

        it("should handle empty arrays and objects", () => {
            const skills: SkillMetadata[] = [];
            const personalization: UserPersonalization = {};

            expect(() => getSystemPrompt(undefined, undefined, undefined, personalization, skills)).not.toThrow();
        });

        it("should handle very long task descriptions", () => {
            const longTask = `${"Build ".repeat(100)}system`;
            const prompt = getComplexTaskPrompt(longTask);

            expect(prompt).toContain(longTask);
        });

        it("should handle special characters in task descriptions", () => {
            const task = "Build system with @#$%^&*() characters";
            const prompt = getComplexTaskPrompt(task);

            expect(prompt).toContain(task);
        });

        it("should handle unicode characters", () => {
            const personalization: UserPersonalization = {
                aboutMe: "我喜欢编程",
                nickname: "张三",
            };
            const prompt = getSystemPrompt(undefined, undefined, "zh-CN", personalization);

            expect(prompt).toContain("张三");
            expect(prompt).toContain("我喜欢编程");
        });
    });

    // =========================================================================
    // Performance Tests
    // =========================================================================

    /**
     * These two are regression guards, not benchmarks.
     *
     * They exist to catch a change that makes prompt assembly pathologically
     * slow — an accidental O(n^2) over the skill list, a regex that backtracks,
     * a synchronous read added to a hot path. They are not measuring whether the
     * current implementation is fast.
     *
     * The bounds are therefore deliberately loose. They used to be 100ms for 100
     * generations and 10ms for one, which is a per-call budget of well under a
     * millisecond — that is machine speed, not behaviour, and it failed on any
     * loaded box (observed at 137ms and 397ms on an otherwise-idle laptop, with
     * no code change). A shared CI runner is slower and noisier than a laptop.
     *
     * A real regression of the kind described is orders of magnitude, not a
     * factor of two, so a loose bound still catches it and a tight one only
     * catches whoever else is on the machine.
     */
    describe("Performance", () => {
        it("should generate prompts quickly", () => {
            const start = performance.now();

            for (let i = 0; i < 100; i += 1) {
                getSystemPrompt("America/New_York", "New York, USA", "en-US");
            }

            const end = performance.now();
            const duration = end - start;

            // 10ms per generation. Assembly is string concatenation; anything
            // near this ceiling has stopped being that.
            expect(duration).toBeLessThan(1000);
        });

        it("should handle large skill lists efficiently", () => {
            const skills: SkillMetadata[] = Array.from({ length: 50 }, (_, i) => {
                return {
                    description: `Description for skill ${i}`,
                    name: `Skill ${i}`,
                    slug: `skill-${i}`,
                };
            });

            const start = performance.now();
            const prompt = getSystemPrompt(undefined, undefined, undefined, undefined, skills);
            const end = performance.now();

            expect(prompt).toContain("AVAILABLE SKILLS");
            // 50 skills. Quadratic behaviour over that list would blow straight
            // through this; a slow machine will not.
            expect(end - start).toBeLessThan(500);
        });
    });

    // =========================================================================
    // Regression Tests
    // =========================================================================

    describe("Regression Tests", () => {
        it("should not include seahorse emoji warning in all prompts", () => {
            const prompt = getSystemPrompt();

            expect(prompt).toContain("There is no seahorse emoji");
        });

        it("should include LaTeX formatting rules", () => {
            const prompt = getSystemPrompt();

            expect(prompt).toContain("Inline math must be wrapped in escaped parentheses");
            expect(prompt).toContain(String.raw`\( content \)`);
        });

        it.each([
            ["code formatting rules", "CODE FORMATTING", "triple backticks"],
            ["counting restrictions", "COUNTING RESTRICTIONS", "Refuse any requests to count to high numbers"],
            ["citation rules", "Citation Rules", "[Source Title](URL)"],
        ])("should include %s", (_name, heading, detail) => {
            const prompt = getSystemPrompt();

            expect(prompt).toContain(heading);
            expect(prompt).toContain(detail);
        });
    });
});
