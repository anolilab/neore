import type { Infer } from "lunorash/server";
import { v } from "lunorash/server";

import type { DraftFrom, NotTypedDraft } from "./not-typed-text";

/**
 * Where a draft the owner did not type came from (`not-typed-text.ts#NOT_TYPED_DRAFTS`), declared once for the stored mark and
 * every send's `draftFrom`. An inline `v.union(...)` of literals: codegen resolves that, not one built by a call.
 */
export const vNotTypedDraft = v.union(
    v.literal("promptLink"),
    v.literal("shellLink"),
    v.literal("sharedPrompt"),
    v.literal("forwarded"),
    v.literal("assistantText"),
    v.literal("suggestion"),
    v.literal("improvedPrompt"),
    v.literal("galleryPrompt"),
    v.literal("organizationValue"),
    v.literal("collaborator"),
);

/** A send's `draftFrom` (`not-typed-text.ts#DraftFrom`): a draft's source, or `impersonated`. */
export const vDraftFrom = v.union(vNotTypedDraft, v.literal("impersonated"));

/** A stored not-typed mark (`not-typed-text.ts#NotTypedMarks`), for a column or an output. */
export const vNotTypedMarks = v.object({
    draft: v.optional(vNotTypedDraft),
    impersonated: v.optional(v.literal(true)),
});

// A kind added to `NOT_TYPED_DRAFTS` and not here, or here and not there, fails the type check.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Holds<T extends true> = T;

export type ValidatorsMatchNotTypedDrafts = [Holds<Same<Infer<typeof vNotTypedDraft>, NotTypedDraft>>, Holds<Same<Infer<typeof vDraftFrom>, DraftFrom>>];
