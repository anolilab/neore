import { describe, expect, it } from "vitest";

import type { CategoryPinMap, SpecificityCategory } from "./specificity.js";
import { classifySpecificity, PIN_MIN_CONFIDENCE, resolveCategoryPin } from "./specificity.js";

describe(classifySpecificity, () => {
    it("falls back to `general` at 0.5 when nothing matches", () => {
        expect(classifySpecificity("what is the capital of France?")).toEqual({ category: "general", confidence: 0.5 });
        expect(classifySpecificity("")).toEqual({ category: "general", confidence: 0.5 });
    });

    describe("by keyword alone", () => {
        it.each<[SpecificityCategory, string]>([
            ["coding", "Please refactor this module"],
            ["coding", "I get a stack trace when I compile"],
            ["web_browsing", "scrape the pricing table"],
            ["web_browsing", "click the login button"],
            ["data_analysis", "build a pivot table of sales"],
            ["data_analysis", "what is the p-value of this regression?"],
            ["image_generation", "generate an image of a lighthouse"],
            ["image_generation", "design a logo for my bakery"],
            ["video_generation", "generate a video of waves"],
            ["video_generation", "I need some b-roll"],
            ["social_media", "write a tweet about our launch"],
            ["social_media", "add hashtags to this caption"],
            ["email_management", "draft an email to my landlord"],
            ["email_management", "what is in my inbox"],
            ["calendar_management", "schedule a meeting with Anna"],
            ["calendar_management", "please reschedule my 3pm"],
            ["trading", "what is my portfolio worth"],
            ["trading", "place a buy order for btc"],
        ])("reads %s from %j at 0.65 confidence", (category, message) => {
            expect(classifySpecificity(message)).toEqual({ category, confidence: 0.65 });
        });

        it("matches whole words and ignores case", () => {
            expect(classifySpecificity("REFACTOR THIS").category).toBe("coding");
            // `rustic` / `pythonic` must not trip the `rust` / `python` keywords.
            expect(classifySpecificity("describe a rustic cabin").category).toBe("general");
            expect(classifySpecificity("an accent in a pythonic way").category).toBe("general");
        });
    });

    describe("by tool name alone", () => {
        it.each<[SpecificityCategory, string]>([
            ["coding", "code_interpreter"],
            ["coding", "shell"],
            ["web_browsing", "web_search"],
            ["web_browsing", "browser_click"],
            ["data_analysis", "sql_query"],
            ["image_generation", "generate_image"],
            ["video_generation", "create_video"],
            ["social_media", "twitter_post"],
            ["email_management", "gmail_send"],
            ["calendar_management", "gcal_create"],
            ["trading", "binance_order"],
        ])("reads %s from the %j tool at 0.9 confidence", (category, tool) => {
            expect(classifySpecificity("hello", [tool])).toEqual({ category, confidence: 0.9 });
        });

        it("matches tool prefixes case-insensitively and only at the start of the name", () => {
            expect(classifySpecificity("hello", ["GMAIL_Send"]).category).toBe("email_management");
            expect(classifySpecificity("hello", ["my_gmail_send"]).category).toBe("general");
        });
    });

    describe("when tools and keywords both speak", () => {
        it("lets a tool outweigh a keyword that points elsewhere", () => {
            expect(classifySpecificity("debug this typescript error", ["gmail_send"])).toEqual({ category: "email_management", confidence: 0.9 });
        });

        it("reports 0.95 when a tool and a keyword agree on the category", () => {
            expect(classifySpecificity("refactor this", ["code_interpreter"])).toEqual({ category: "coding", confidence: 0.95 });
        });

        it("caps confidence at 0.95 when several tools of one category match", () => {
            expect(classifySpecificity("hello", ["code_run", "python", "git_diff"])).toEqual({ category: "coding", confidence: 0.95 });
        });

        it("picks the category with the most evidence", () => {
            // email: tool (3) + keyword (1); coding: keyword (1).
            expect(classifySpecificity("draft an email and refactor nothing", ["gmail_send"]).category).toBe("email_management");
        });
    });

    it("defaults to no tools", () => {
        expect(classifySpecificity("hello")).toEqual(classifySpecificity("hello", []));
    });
});

describe(resolveCategoryPin, () => {
    const pins: CategoryPinMap = { coding: { modelId: "claude-sonnet-4", provider: "anthropic" } };

    it("returns the pin when the category is pinned and the classification is confident", () => {
        expect(resolveCategoryPin("coding", 0.95, pins)).toEqual({ modelId: "claude-sonnet-4", provider: "anthropic" });
    });

    it("applies from exactly the confidence floor, and not below it", () => {
        expect(PIN_MIN_CONFIDENCE).toBeCloseTo(0.9, 10);
        expect(resolveCategoryPin("coding", 0.9, pins)).toBeDefined();
        expect(resolveCategoryPin("coding", 0.89, pins)).toBeUndefined();
    });

    it("never pins on a keyword-only classification", () => {
        const { category, confidence } = classifySpecificity("refactor this");

        expect(resolveCategoryPin(category, confidence, pins)).toBeUndefined();
    });

    it("pins on a tool-backed classification", () => {
        const { category, confidence } = classifySpecificity("hello", ["code_interpreter"]);

        expect(resolveCategoryPin(category, confidence, pins)).toEqual(pins.coding);
    });

    it("returns undefined for an unpinned category or a missing map", () => {
        expect(resolveCategoryPin("trading", 0.95, pins)).toBeUndefined();
        expect(resolveCategoryPin("coding", 0.95, undefined)).toBeUndefined();
        expect(resolveCategoryPin("coding", 0.95, {})).toBeUndefined();
    });
});
