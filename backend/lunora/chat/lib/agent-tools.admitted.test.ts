/**
 * `withAdmittedBuiltIns` is the one place a run's admission reaches the
 * knowledge tool. Only an admitted run gets the variant that forwards
 * `admittedRun`; every other run keeps the fail-closed tool.
 */
import { describe, expect, it } from "vitest";

import { ToolName } from "../tools";
import { admittedKnowledgeSearchTool } from "../tools/knowledge-search";
import knowledgeSearchTool from "../tools/knowledge-search";
import { withAdmittedBuiltIns } from "./agent-tools";

const builtIns = { other: {}, [ToolName.KnowledgeSearch]: knowledgeSearchTool } as never;

describe(withAdmittedBuiltIns, () => {
    it("swaps in the admitted knowledge tool for an admitted run (positive)", () => {
        const tools = withAdmittedBuiltIns(builtIns, true) as Record<string, unknown>;

        expect(tools[ToolName.KnowledgeSearch]).toBe(admittedKnowledgeSearchTool);
        expect(tools.other).toBe((builtIns as Record<string, unknown>).other);
    });

    it("keeps the fail-closed knowledge tool for a run that was not admitted (negative)", () => {
        expect(withAdmittedBuiltIns(builtIns, undefined)).toBe(builtIns);
        expect(withAdmittedBuiltIns(builtIns, false)).toBe(builtIns);
    });
});
