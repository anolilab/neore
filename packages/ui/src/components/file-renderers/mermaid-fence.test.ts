import { needsHeavyStreamdownPlugins } from "@ui/hooks/use-streamdown-plugins";
import { describe, expect, it } from "vitest";

import { toMermaidFence } from "./mermaid-fence";

describe(toMermaidFence, () => {
    it("wraps a source in a mermaid fence that the heavy-plugin check detects", () => {
        const fenced = toMermaidFence("graph TD\nA-->B");

        expect(fenced).toBe("```mermaid\ngraph TD\nA-->B\n```");
        expect(needsHeavyStreamdownPlugins(fenced)).toBe(true);
    });

    it("uses a fence longer than any backtick run in the source", () => {
        const fenced = toMermaidFence('graph TD\nA["```code```"]-->B');

        expect(fenced.startsWith("````mermaid\n")).toBe(true);
        expect(fenced.endsWith("\n````")).toBe(true);
    });

    it("keeps the heavy-plugin check true when the source holds a triple-backtick run", () => {
        const fenced = toMermaidFence('graph TD\nA["```code```"]-->B');

        expect(needsHeavyStreamdownPlugins(fenced)).toBe(true);
    });

    it("does not detect a plain code block with no mermaid language", () => {
        expect(needsHeavyStreamdownPlugins("```ts\nconst a = 1;\n```")).toBe(false);
        expect(needsHeavyStreamdownPlugins("````\nmermaid\n````")).toBe(false);
    });
});
