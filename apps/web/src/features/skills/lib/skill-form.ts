/**
 * Form model and validation for the skill editor.
 *
 * The limits mirror what the backend enforces (`backend/lunora/skills/constants.ts`
 * and `validators.ts`) so the dialog reports a problem before the round trip. The
 * backend stays authoritative — this is feedback, not a gate.
 */

export const SKILL_NAME_MAX = 100;
export const SKILL_SLUG_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;
export const SKILL_INSTRUCTIONS_MAX = 10_000;
/** Mirrors `vSkillConfigInput.voice`. */
export const SKILL_VOICE_MAX = 200;

export const SKILL_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const RESERVED_SKILL_SLUGS = ["anthropic", "claude", "neore", "system", "admin"];

export const SKILL_CATEGORIES = ["automation", "research", "coding", "data", "communication"] as const;

export type SkillVisibility = "organization" | "private" | "public";

export interface SkillVariable {
    defaultValue?: string;
    description?: string;
    name: string;
    required?: boolean;
}

export interface SkillFormValues {
    additionalTools: string[];
    category: string;
    description: string;
    disabledTools: string[];
    instructions: string;
    name: string;
    preferredModel?: string;
    slug: string;
    tags: string;
    variables: SkillVariable[];
    visibility: SkillVisibility;
    /** Voice replies are read aloud in: a browser voice name or a language tag. Empty = default. */
    voice: string;
}

/** The subset of a `skills` row the editor reads. */
export interface EditableSkill {
    category?: string;
    config?: { additionalTools?: string[]; disabledTools?: string[]; preferredModel?: string; reasoningEffort?: number; searchMode?: string; voice?: string };
    description: string;
    instructions: string;
    name: string;
    slug: string;
    tags?: string[];
    variables?: SkillVariable[];
    visibility?: string;
}

/** Messages are resolved by the caller so this module stays free of lingui. */
export type SkillFormMessageKey =
    | "descriptionRequired"
    | "descriptionTooLong"
    | "instructionsRequired"
    | "instructionsTooLong"
    | "nameRequired"
    | "nameTooLong"
    | "slugFormat"
    | "slugRequired"
    | "slugReserved"
    | "slugTooLong"
    | "toolConflict"
    | "voiceTooLong";

const NON_SLUG_CHARS_RE = /[^a-z0-9]+/g;
// `NON_SLUG_CHARS_RE` collapses every run to one hyphen, so an edge carries at most one.
const EDGE_HYPHENS_RE = /^-|-$/g;
const TAG_SEPARATOR_RE = /[,\n]/;

export const slugifySkillName = (value: string): string =>
    value
        .normalize("NFKD")
        .toLowerCase()
        .replaceAll(NON_SLUG_CHARS_RE, "-")
        .replaceAll(EDGE_HYPHENS_RE, "")
        .slice(0, SKILL_SLUG_MAX)
        .replaceAll(EDGE_HYPHENS_RE, "");

export const parseTags = (value: string): string[] => [
    ...new Set(
        value
            .split(TAG_SEPARATOR_RE)
            .map((tag) => tag.trim().toLowerCase())
            .filter(Boolean),
    ),
];

const toVisibility = (value: string | undefined): SkillVisibility => (value === "public" || value === "organization" ? value : "private");

export const getSkillFormDefaults = (skill?: EditableSkill | null): SkillFormValues => {
    return {
        additionalTools: skill?.config?.additionalTools ?? [],
        category: skill?.category ?? "",
        description: skill?.description ?? "",
        disabledTools: skill?.config?.disabledTools ?? [],
        instructions: skill?.instructions ?? "",
        name: skill?.name ?? "",
        preferredModel: skill?.config?.preferredModel,
        slug: skill?.slug ?? "",
        tags: skill?.tags?.join(", ") ?? "",
        variables: skill?.variables ?? [],
        visibility: toVisibility(skill?.visibility),
        voice: skill?.config?.voice ?? "",
    };
};

export const validateSkillForm = (values: SkillFormValues): Partial<Record<keyof SkillFormValues, SkillFormMessageKey>> => {
    const errors: Partial<Record<keyof SkillFormValues, SkillFormMessageKey>> = {};
    const name = values.name.trim();
    const slug = values.slug.trim();
    const description = values.description.trim();
    const instructions = values.instructions.trim();

    if (!name) {
        errors.name = "nameRequired";
    } else if (name.length > SKILL_NAME_MAX) {
        errors.name = "nameTooLong";
    }

    if (!slug) {
        errors.slug = "slugRequired";
    } else if (slug.length > SKILL_SLUG_MAX) {
        errors.slug = "slugTooLong";
    } else if (!SKILL_SLUG_RE.test(slug)) {
        errors.slug = "slugFormat";
    } else if (RESERVED_SKILL_SLUGS.includes(slug)) {
        errors.slug = "slugReserved";
    }

    if (!description) {
        errors.description = "descriptionRequired";
    } else if (description.length > SKILL_DESCRIPTION_MAX) {
        errors.description = "descriptionTooLong";
    }

    if (!instructions) {
        errors.instructions = "instructionsRequired";
    } else if (instructions.length > SKILL_INSTRUCTIONS_MAX) {
        errors.instructions = "instructionsTooLong";
    }

    if (values.voice.trim().length > SKILL_VOICE_MAX) {
        errors.voice = "voiceTooLong";
    }

    const disabled = new Set(values.disabledTools);

    if (values.additionalTools.some((tool) => disabled.has(tool))) {
        errors.disabledTools = "toolConflict";
    }

    return errors;
};

/**
 * The `createSkill` / `updateSkill` payload fields shared by both.
 *
 * `config` is replaced wholesale on update, so the settings this editor does not
 * show (`reasoningEffort`, `searchMode`) are carried over from the existing row
 * rather than silently dropped.
 */
export const toSkillPayload = (values: SkillFormValues, existingConfig?: EditableSkill["config"]) => {
    const tags = parseTags(values.tags);
    const config = {
        ...(existingConfig?.reasoningEffort !== undefined && { reasoningEffort: existingConfig.reasoningEffort }),
        ...(existingConfig?.searchMode !== undefined && { searchMode: existingConfig.searchMode }),
        ...(values.additionalTools.length > 0 && { additionalTools: values.additionalTools }),
        ...(values.disabledTools.length > 0 && { disabledTools: values.disabledTools }),
        ...(values.preferredModel && { preferredModel: values.preferredModel }),
        ...(values.voice.trim() && { voice: values.voice.trim() }),
    };

    return {
        category: values.category || undefined,
        config,
        description: values.description.trim(),
        instructions: values.instructions.trim(),
        name: values.name.trim(),
        slug: values.slug.trim(),
        tags,
        variables: values.variables.map((variable) => {
            return {
                ...(variable.defaultValue && { defaultValue: variable.defaultValue }),
                ...(variable.description && { description: variable.description }),
                name: variable.name,
                ...(variable.required !== undefined && { required: variable.required }),
            };
        }),
        visibility: values.visibility,
    };
};
