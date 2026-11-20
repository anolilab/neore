import { v } from "lunorash/server";

/** A stored not-typed mark (`not-typed-text.ts#NotTypedMarks`), for a column or an output. */
export const vNotTypedMarks = v.object({
    draft: v.optional(
        v.union(
            v.literal("promptLink"),
            v.literal("shellLink"),
            v.literal("sharedPrompt"),
            v.literal("forwarded"),
            v.literal("assistantText"),
            v.literal("suggestion"),
            v.literal("improvedPrompt"),
            v.literal("galleryPrompt"),
            v.literal("organizationValue"),
        ),
    ),
    impersonated: v.optional(v.literal(true)),
});
