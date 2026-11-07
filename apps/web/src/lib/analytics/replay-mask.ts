/**
 * Session replay masks the text inside an element that carries this attribute. The composer's editor carries it, so the draft a prompt
 * link puts there (and anything the person types) is not recorded as text. The provider names the selector to PostHog
 * (`session_recording.maskTextSelector`), and the editor sets the attribute with the same constant, so the two cannot drift.
 */
export const REPLAY_MASK_ATTRIBUTE = "data-ph-mask";

/** The selector PostHog's session recording uses for the attribute. */
export const REPLAY_MASK_SELECTOR = `[${REPLAY_MASK_ATTRIBUTE}]`;

/** The attribute as props, spread onto an element whose text replay must not record. */
export const REPLAY_MASKED_PROPS: Record<string, string> = { [REPLAY_MASK_ATTRIBUTE]: "" };
