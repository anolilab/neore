import type { DraftFrom } from "@neore/backend/not-typed-text";

import { useChatUIStore } from "../stores/chat-ui-store";

/**
 * Text that entered the composer without the person typing it: a prompt link (`?prompt=`, a chat's `?initialMessage=`), the
 * desktop shell (a `neore://new?text=` link, a share, the Quick Composer), a saved prompt whose words someone else wrote,
 * forwarded messages, a suggestion they clicked, the prompt improver's rewrite, a gallery item's stored prompt, or an
 * organization's value filled into a prompt. The draft
 * carries the mark (`composerDraftFrom` in `chat-ui-store.ts`) from then on, through edits, a pane switch, a reload
 * (`split/stored-drafts.ts`), the queue and a failed send handed back, until it is sent or emptied. A send names it
 * (`draftFrom`), and the backend saves the prompt marked (`backend/lunora/lib/not-typed-text.ts`), so the agent never reads it
 * as the person's own words when deciding what it may do on their behalf (a saved site login).
 *
 * Set it after the text is in: emptying the draft drops the mark.
 */
export type DraftOrigin = DraftFrom;

/** Marks the live composer's draft as holding text from `origin`. */
export const markComposerDraft = (origin: DraftOrigin): void => {
    useChatUIStore.getState().setComposerDraftFrom(origin);
};

/** The live composer's mark, read when its draft leaves it (a send, the queue, a steer). */
export const composerDraftFrom = (): DraftOrigin | undefined => useChatUIStore.getState().composerDraftFrom;

/** What the composer needs of a saved prompt to tell whose words it holds (`backend/lunora/prompts/content-author.ts`). */
export type SavedPromptAuthorship = {
    contentBy?: string;
    contentByImpersonator?: boolean;
    contentByOthers?: boolean;
    organizationId?: string;
    userId: string;
};

/**
 * Whether the viewer wrote all of the prompt's current words, themselves and not an admin acting as them. The owner's id
 * says nothing about that: a teammate may have edited it, and one other writer of any part makes it someone else's. A row
 * from before the writers were recorded is the viewer's only if it is their own personal prompt; an organization's could
 * hold anyone's words.
 */
export const isOwnPromptContent = (prompt: SavedPromptAuthorship, viewerId: string | undefined): boolean => {
    if (viewerId === undefined || prompt.contentByImpersonator === true || prompt.contentByOthers === true) {
        return false;
    }

    if (prompt.contentBy === undefined) {
        return prompt.userId === viewerId && !prompt.organizationId;
    }

    return prompt.contentBy === viewerId;
};

/**
 * A saved prompt put into the composer. One whose words someone else wrote (`isOwnPromptContent`; an unknown viewer counts
 * as someone else) marks the draft. The person's own unmarks it only when it `replaced` the whole draft: inserted into
 * other text, that text keeps its mark.
 */
export const noteSavedPrompt = (prompt: SavedPromptAuthorship, viewerId: string | undefined, { replaced }: { replaced: boolean }): void => {
    if (!isOwnPromptContent(prompt, viewerId)) {
        markComposerDraft("sharedPrompt");
    } else if (replaced) {
        useChatUIStore.getState().setComposerDraftFrom(undefined);
    }
};

/** A request's `draftFrom`, spread into its body: nothing for the person's own words. */
export const draftFromField = (origin: DraftOrigin | undefined): { draftFrom?: DraftOrigin } => (origin === undefined ? {} : { draftFrom: origin });

/** The mark of the new-chat hand-off the chat index read last (`handOffLandingMessage`), until the composer applies it. */
const landing: { draftFrom: DraftOrigin | undefined } = { draftFrom: undefined };

/** Set when the chat index reads a hand-off: its mark, or none, so an earlier one never marks the next. Taken by `prefillDraftFrom`. */
export const holdLandingDraftFrom = (origin: DraftOrigin | undefined): void => {
    landing.draftFrom = origin;
};

/**
 * The mark of a composer's `initialMessage` prefill, taken when the text is put in. A chat's comes from its address
 * (`/chat/$threadId?initialMessage=`), which a link wrote. The new-chat composer's is its hand-off's
 * (`handOffLandingMessage`): none for text typed on the landing or home page, `forwarded` for forwarded messages,
 * `suggestion` for an onboarding template.
 */
export const prefillDraftFrom = (threadId: string | undefined): DraftOrigin | undefined => {
    if (threadId) {
        return "promptLink";
    }

    const origin = landing.draftFrom;

    landing.draftFrom = undefined;

    return origin;
};
