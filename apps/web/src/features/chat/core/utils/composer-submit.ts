/**
 * "Send this as a new chat" from OUTSIDE the chat UI — today only the native
 * shell's Quick Composer (`lib/native/native-bridge.tsx`). Opt-in by
 * construction: nothing in the web app calls `requestComposerSubmit`, so no
 * browser flow ever sends a message the user did not type and submit.
 *
 * The request is held by a request channel (`core/stores/request-channel-store.ts`)
 * until the NEW-thread composer takes it, so a request made while `/chat` is
 * still loading is sent once that composer mounts and is ready, not dropped.
 */

import { createRequestChannel } from "@/features/chat/core/stores/request-channel-store";

export interface ComposerSubmitRequest {
    text: string;
}

const composerSubmitChannel = createRequestChannel<ComposerSubmitRequest>();

export const requestComposerSubmit = (request: ComposerSubmitRequest): void => {
    composerSubmitChannel.request(request);
};

/** Subscribes the new-thread composer — including to a request made before it mounted. */
export const onComposerSubmitRequest = (handler: (request: ComposerSubmitRequest) => void): (() => void) => composerSubmitChannel.consume(handler);

export interface ComposerAttachRequest {
    files: File[];
}

const composerAttachChannel = createRequestChannel<ComposerAttachRequest>();

/** Files dropped on the dock icon. The new-thread composer attaches them through its normal upload path; nothing is sent. */
export const requestComposerAttach = (request: ComposerAttachRequest): void => {
    composerAttachChannel.request(request);
};

export const onComposerAttachRequest = (handler: (request: ComposerAttachRequest) => void): (() => void) => composerAttachChannel.consume(handler);
