import { describe, expect, it } from "vitest";

import { openAIToolsToToolSet, toToolSet } from "../lib/tool-set.js";
import { stripReasoningOptions } from "../providers/options-filter.js";

describe("lib/tool-set", () => {
    const weather = {
        description: "Look up the weather",
        name: "get_weather",
        parameters: { properties: { city: { type: "string" } }, required: ["city"], type: "object" },
    };

    it("keys the set by tool name, not by array index", () => {
        // The failure this exists to prevent: handing the array straight to the
        // SDK makes Object.keys() return "0", "1", ... so the model is told
        // about tools whose names match nothing the caller can execute.
        const set = toToolSet([weather, { description: "Add", name: "add", parameters: { type: "object" } }]);

        expect(Object.keys(set!)).toEqual(["get_weather", "add"]);
    });

    it("puts the schema on inputSchema, which is the field the SDK reads", () => {
        const set = toToolSet([weather])!;
        const tool = set["get_weather"] as { inputSchema: { jsonSchema: unknown } };

        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.jsonSchema).toEqual(weather.parameters);
        // `parameters` is the v4 name and is silently ignored by v6.
        expect(tool).not.toHaveProperty("parameters");
    });

    it("gives a parameterless tool an empty object schema rather than nothing", () => {
        const set = toToolSet([{ description: "Ping", name: "ping", parameters: {} }])!;
        const tool = set["ping"] as { inputSchema: { jsonSchema: unknown } };

        expect(tool.inputSchema.jsonSchema).toEqual({ properties: {}, type: "object" });
    });

    it("returns undefined for an empty or absent list so callers can skip the field", () => {
        expect(toToolSet(undefined)).toBeUndefined();
        expect(toToolSet([])).toBeUndefined();
    });

    it("unwraps the OpenAI function envelope", () => {
        const set = openAIToolsToToolSet([{ function: { description: "Search the web", name: "search", parameters: { type: "object" } } }])!;

        expect(Object.keys(set)).toEqual(["search"]);
        expect((set["search"] as { description: string }).description).toBe("Search the web");
    });
});

describe("providers/options-filter — stripReasoningOptions", () => {
    const options = { cacheControl: { type: "ephemeral" }, thinking: { type: "adaptive" } };

    it("drops reasoning-only keys for a model that cannot accept them", () => {
        expect(stripReasoningOptions(options, false)).toEqual({ cacheControl: { type: "ephemeral" } });
    });

    it("leaves them alone for a model that supports reasoning", () => {
        expect(stripReasoningOptions(options, true)).toEqual(options);
    });

    it("leaves them alone when the capability is unknown", () => {
        // Stripping on a guess would silently disable thinking on any model
        // whose metadata has not been filled in — worse than the 400 this
        // exists to prevent, because it is invisible.
        expect(stripReasoningOptions(options, undefined)).toEqual(options);
    });

    it("returns undefined when stripping empties the bag", () => {
        expect(stripReasoningOptions({ reasoningEffort: "high" }, false)).toBeUndefined();
    });

    it("passes undefined through untouched", () => {
        expect(stripReasoningOptions(undefined, false)).toBeUndefined();
    });
});
