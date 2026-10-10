/**
 * Design prompt enhancer — applies design principles, style modifiers, and dimension-aware
 * layout hints to improve AI-generated design quality.
 */

import type { DesignPreset } from "./presets";
import type { DesignStyle } from "./styles";

/** 12 design principles used for prompt enhancement. */
export const DESIGN_PRINCIPLES = [
    "Rule of thirds: Place key elements at intersection points of a 3×3 grid",
    "Visual hierarchy: Guide the eye from most to least important element",
    "Contrast: Use color, size, and weight to create emphasis",
    "Alignment: Keep elements aligned to create visual order",
    "Repetition: Reuse design elements for consistency",
    "Proximity: Group related elements together",
    "White space: Leave breathing room around elements",
    "Color theory: Use complementary or analogous color schemes",
    "Typography: Limit to 2-3 fonts, establish clear hierarchy",
    "Balance: Distribute visual weight evenly (symmetrical or asymmetrical)",
    "Consistency: Maintain style across all elements",
    "Simplicity: Remove unnecessary elements, every element must earn its place",
] as const;

/** Orientation hint based on preset dimensions. */
const getOrientationHint = (preset: DesignPreset): string => {
    const ratio = preset.width / preset.height;

    if (ratio > 1.5) {
        return "wide landscape format — use horizontal flow, wide text areas";
    }

    if (ratio > 1.1) {
        return "landscape format — balance left-to-right composition";
    }

    if (ratio > 0.9) {
        return "square format — center-weighted composition works well";
    }

    if (ratio > 0.6) {
        return "portrait format — stack elements vertically, top-to-bottom flow";
    }

    return "tall portrait format — use vertical stacking, large hero at top";
};

/**
 * Enhance a user's design prompt with style modifiers, dimension awareness, and design principles.
 */
export const enhanceDesignPrompt = (userPrompt: string, style?: DesignStyle, preset?: DesignPreset): string => {
    const parts: string[] = [userPrompt];

    if (style) {
        parts.push(`Style: ${style.promptModifier}`);
    }

    if (preset) {
        parts.push(`Canvas: ${preset.width}×${preset.height}px (${preset.description}). ${getOrientationHint(preset)}`);
    }

    // Add 3 most relevant design principles (keeps prompt concise)
    parts.push("Follow these design principles: visual hierarchy, contrast, and white space.");

    return parts.join(". ");
};

/**
 * Build a system prompt for AI canvas composition — instructs the AI to generate
 * structured canvas elements (text, shapes, images) rather than free-form content.
 */
export const buildCanvasSystemPrompt = (preset?: DesignPreset, style?: DesignStyle): string => {
    const lines = [
        "You are a professional graphic designer creating visual compositions.",
        "Generate structured canvas elements that follow professional design principles.",
    ];

    if (preset) {
        lines.push(`Canvas size: ${preset.width}×${preset.height}px (${preset.name} — ${preset.description}).`);
    }

    if (style) {
        lines.push(`Design style: ${style.name} — ${style.description}.`);
    }

    lines.push(
        "Position elements using absolute coordinates within the canvas bounds.",
        "Use the rule of thirds for element placement.",
        "Ensure text is readable with sufficient contrast against backgrounds.",
    );

    return lines.join("\n");
};
