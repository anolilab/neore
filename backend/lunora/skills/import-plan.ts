/**
 * What a parsed SKILL.md becomes on import — shared by a single import
 * (`io.ts#importSkill`) and a bundle (`bundle-plan.ts`), so both treat tools
 * the same way: a tool this app does not have is dropped with a warning (a
 * skill written for another host names tools this app lacks).
 */
import { omit } from "../lib/collections";
import type { SkillMarkdownData } from "./markdown";

export type PlannedSkill = SkillMarkdownData & {
    /** Tools named in `allowed-tools` / `disabled-tools` that were dropped. */
    droppedTools: string[];
    warnings: string[];
};

export const planSkillImport = (skill: SkillMarkdownData, isKnownTool: (name: string) => boolean): PlannedSkill => {
    const warnings: string[] = [];
    const droppedTools: string[] = [];
    const keepKnown = (tools: string[] | undefined, label: string): string[] | undefined => {
        if (!tools) {
            return undefined;
        }

        const unknown = tools.filter((tool) => !isKnownTool(tool));

        if (unknown.length > 0) {
            warnings.push(`${label}: not available here, ignored: ${unknown.join(", ")}`);
            droppedTools.push(...unknown);
        }

        const known = tools.filter((tool) => isKnownTool(tool));

        return known.length > 0 ? known : undefined;
    };
    const additionalTools = keepKnown(skill.config?.additionalTools, "allowed-tools");
    const disabledTools = keepKnown(skill.config?.disabledTools, "disabled-tools");
    const kept = {
        ...omit(skill.config ?? {}, ["additionalTools", "disabledTools"]),
        ...(additionalTools && { additionalTools }),
        ...(disabledTools && { disabledTools }),
    };
    const config = Object.keys(kept).length > 0 ? kept : undefined;

    return { ...skill, config, droppedTools, warnings };
};
