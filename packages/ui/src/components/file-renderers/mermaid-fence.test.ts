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
});
