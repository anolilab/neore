import { describe, expect, it } from "vitest";

import { validateSlug } from "../../skills/validators";
import { MAX_GROUP_PARTICIPANTS, normalizeGroupOptions, planTurn } from "./logic";
import { findGroupTemplate, GROUP_TEMPLATES } from "./templates";

describe("group chat templates", () => {
    it("seeds the code review panel and the pros & cons debate", () => {
        expect(findGroupTemplate("code-review-panel")?.mode).toBe("parallel");
        expect(findGroupTemplate("pros-cons-debate")?.mode).toBe("debate");
        expect(findGroupTemplate("nope")).toBeUndefined();
    });

    it.each(GROUP_TEMPLATES)("$id: valid, unique persona slugs and a synthesizer among them", (template) => {
        const slugs = template.personas.map((persona) => persona.slug);

        expect(new Set(slugs).size).toBe(slugs.length);
        expect(slugs.length).toBeGreaterThanOrEqual(2);
        expect(slugs.length).toBeLessThanOrEqual(MAX_GROUP_PARTICIPANTS);

        for (const persona of template.personas) {
            expect(validateSlug(persona.slug)).toMatchObject({ valid: true });
            expect(persona.name.trim()).not.toBe("");
            expect(persona.instructions.trim()).not.toBe("");
        }

        if (template.synthesizerSlug) {
            expect(slugs).toContain(template.synthesizerSlug);
        }
    });

    it.each(GROUP_TEMPLATES)("$id: its options pass the same check a hand-built group does, and plan a synthesis", (template) => {
        const skillIds = template.personas.map((persona) => `id-${persona.slug}`);
        const synthesizerSkillId = template.synthesizerSlug && `id-${template.synthesizerSlug}`;
        const result = normalizeGroupOptions({ debateRounds: template.debateRounds, mode: template.mode, skillIds, synthesizerSkillId });

        expect(result).not.toHaveProperty("error");

        const plan = planTurn({
            ...("options" in result && result.options),
            lastSpeakerSkillId: undefined,
            mentions: [],
            mode: template.mode,
            participants: template.personas.map((persona) => {
                return { description: persona.description, name: persona.name, skillId: `id-${persona.slug}`, slug: persona.slug };
            }),
        });

        expect(plan.kind).toBe("steps");
        expect(plan.kind === "steps" && plan.steps.at(-1)).toMatchObject({ role: "synthesizer", skillId: synthesizerSkillId });
    });
});
