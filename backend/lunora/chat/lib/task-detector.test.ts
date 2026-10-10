import { describe, expect, it } from "vitest";

import detectTaskComplexity from "./task-detector";

describe("detectTaskComplexity", () => {
    describe("research tasks", () => {
        it("detects research type from keyword", () => {
            const result = detectTaskComplexity("Research AI history and its impact on society");

            expect(result.taskType).toBe("research");
            // "research and" is not a direct substring (there's "ai history" in between)
            // No high complexity indicators match → not complex
            expect(result.isComplex).toBe(false);
        });

        it("detects complex research with direct 'research and' substring", () => {
            const result = detectTaskComplexity("Research and analyze the latest trends in artificial intelligence");

            expect(result.taskType).toBe("research");
            // "research and" is a high complexity indicator substring
            expect(result.isComplex).toBe(true);
        });

        it("detects simple questions as general (short question early return)", () => {
            const result = detectTaskComplexity("What is TypeScript?");

            // Short question (<5 words + ?) returns "general" via early return
            expect(result.taskType).toBe("general");
            expect(result.isComplex).toBe(false);
        });

        it("detects research type even when not complex", () => {
            const result = detectTaskComplexity("Research quantum computing applications");

            expect(result.taskType).toBe("research");
            // Only 4 words, no high complexity indicators → not complex (score 0.15 < 0.5)
            expect(result.isComplex).toBe(false);
        });

        it("detects complex research with 'research and' pattern", () => {
            const result = detectTaskComplexity("Research and compare different quantum computing approaches in depth");

            expect(result.taskType).toBe("research");
            // "research and" triggers high complexity indicator
            expect(result.isComplex).toBe(true);
        });
    });

    describe("coding tasks", () => {
        it("detects coding tasks", () => {
            const result = detectTaskComplexity("Build REST API with authentication");

            expect(result.taskType).toBe("coding");
            expect(result.requiresPlanning).toBe(true);
        });

        it("detects bug fixes as coding", () => {
            const result = detectTaskComplexity("Debug the authentication error");

            expect(result.taskType).toBe("coding");
        });

        it("detects refactoring as complex coding", () => {
            const result = detectTaskComplexity("Refactor the user service to use dependency injection");

            expect(result.taskType).toBe("coding");
            expect(result.isComplex).toBe(true);
            expect(result.requiresPlanning).toBe(true);
        });
    });

    describe("data analysis tasks", () => {
        it("detects data analysis type", () => {
            const result = detectTaskComplexity("Analyze sales data and create visualization");

            expect(result.taskType).toBe("data-analysis");
            // No high complexity indicators match as substrings → not complex
            expect(result.isComplex).toBe(false);
        });

        it("detects complex data analysis with explicit indicators", () => {
            const result = detectTaskComplexity("Build a comprehensive data analysis pipeline with statistics, metrics visualization, and chart generation");

            expect(result.taskType).toBe("data-analysis");
            // "build", "comprehensive" trigger high complexity; >15 words adds score
            expect(result.isComplex).toBe(true);
        });

        it("detects SQL queries as data analysis", () => {
            const result = detectTaskComplexity("Write SQL query to calculate monthly metrics");

            expect(result.taskType).toBe("data-analysis");
        });
    });

    describe("writing tasks", () => {
        it("detects writing tasks", () => {
            const result = detectTaskComplexity("Write documentation for the API endpoints");

            expect(result.taskType).toBe("writing");
        });

        it("detects blog post writing", () => {
            const result = detectTaskComplexity("Draft a blog post about React best practices");

            expect(result.taskType).toBe("writing");
        });
    });

    describe("complexity detection", () => {
        it("doesn't over-detect simple questions", () => {
            const result = detectTaskComplexity("What is 2+2?");

            expect(result.isComplex).toBe(false);
            expect(result.taskType).toBe("general");
        });

        it("detects complex multi-step tasks", () => {
            const result = detectTaskComplexity("Build a comprehensive authentication system with email verification, password reset, and OAuth integration");

            expect(result.isComplex).toBe(true);
            expect(result.requiresPlanning).toBe(true);
        });

        it("detects planning requirements", () => {
            const result = detectTaskComplexity("Plan and implement a migration strategy for the database");

            expect(result.requiresPlanning).toBe(true);
        });

        it("detects validation requirements", () => {
            const result = detectTaskComplexity("Build and validate the payment processing flow");

            expect(result.requiresValidation).toBe(true);
        });
    });

    describe("edge cases", () => {
        it("handles empty strings", () => {
            const result = detectTaskComplexity("");

            expect(result.isComplex).toBe(false);
            expect(result.taskType).toBe("general");
            expect(result.confidence).toBe(1);
        });

        it("handles whitespace-only strings", () => {
            const result = detectTaskComplexity(" ".repeat(3));

            expect(result.isComplex).toBe(false);
            expect(result.taskType).toBe("general");
        });

        it("handles very short messages", () => {
            const result = detectTaskComplexity("Hi");

            expect(result.isComplex).toBe(false);
            expect(result.taskType).toBe("general");
        });

        it("handles question marks for simple questions", () => {
            const result = detectTaskComplexity("How?");

            expect(result.isComplex).toBe(false);
            expect(result.taskType).toBe("general");
        });
    });

    describe("confidence scoring", () => {
        it("has high confidence for clear signals", () => {
            const result = detectTaskComplexity("Build a REST API with authentication");

            expect(result.confidence).toBeGreaterThan(0.7);
        });

        it("has lower confidence for ambiguous messages", () => {
            const result = detectTaskComplexity("Do something");

            expect(result.confidence).toBeLessThan(0.8);
        });
    });

    describe("real-world examples", () => {
        it("example: authentication system", () => {
            const result = detectTaskComplexity("Implement a secure authentication system with JWT tokens, refresh tokens, and email verification");

            expect(result.taskType).toBe("coding");
            expect(result.isComplex).toBe(true);
            expect(result.requiresPlanning).toBe(true);
        });

        it("example: data analysis report", () => {
            const result = detectTaskComplexity("Analyze the user engagement data and create a comprehensive report with visualizations");

            expect(result.taskType).toBe("data-analysis");
            expect(result.isComplex).toBe(true);
        });

        it("example: simple question", () => {
            const result = detectTaskComplexity("What's the weather like today?");

            expect(result.taskType).toBe("general");
            expect(result.isComplex).toBe(false);
        });

        it("example: research task", () => {
            const result = detectTaskComplexity("Research best practices for microservices architecture and provide recommendations");

            expect(result.taskType).toBe("research");
            expect(result.isComplex).toBe(true);
        });
    });
});
