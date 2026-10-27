import { withUnlockProofBody } from "@neore/client-runtime";

import env from "@/lib/env";
import { GatewayDeadlineError, NetworkError } from "@/lib/errors";
import { providerLogger } from "@/lib/logger";

import type { MediaGenerationFailure } from "../lib/start-media-generation";
import { startMediaGeneration } from "../lib/start-media-generation";
import { gatewayError } from "./chat-gateway";
import { reportThreadError } from "./thread-error-sinks";

/** Media kick-off endpoint — generates the image/audio/video for a reply `/v1/chat` created */
const MEDIA_URL = `${env.VITE_LLM_GATEWAY_URL}/v1/chat/media`;

export interface MediaKickOff {
    messageId: string;
    streamingConfig: { contentType: string; imageSize?: string; model: string };
    threadId: string;
}

/** Posts the media kick-off of a reply; a refusal reaches the thread's chat error UI. `onRefused` clears the caller's sending state. */
export type KickOffMedia = (media: MediaKickOff, onRefused?: () => void) => Promise<void>;

/** The error for a media kick-off that failed: the server's own words for a refusal (the daily limit reads as it does from `/v1/chat`), a connection error otherwise. */
const mediaGenerationError = (failure: MediaGenerationFailure, networkMessage: string): Error => {
    if (failure.kind === "network") {
        // A deadline keeps its own wording: the gateway may still be generating, so "check your connection" would mislead.
        return failure.cause instanceof GatewayDeadlineError ? failure.cause : new NetworkError(networkMessage);
    }

    return gatewayError(failure.status, {
        error: failure.retryAfter === undefined ? failure.code : { code: failure.code, message: failure.message, retryAfter: failure.retryAfter },
        message: failure.message,
    });
};

/**
 * Posts the media kick-off for a reply `/v1/chat` created. A refusal (the daily limit, a 401, a 404) or a
 * dead connection goes to the chat error UI of the thread; `onRefused` clears the caller's sending state.
 * `networkMessage` is a thunk so the provider's `t` template stays where Lingui can see it.
 */
export const kickOffMediaGeneration = async (
    media: MediaKickOff,
    headers: Record<string, string>,
    networkMessage: () => string,
    onRefused?: () => void,
): Promise<void> => {
    const result = await startMediaGeneration({ body: withUnlockProofBody(media, media.threadId), headers, url: MEDIA_URL });

    if (result.ok) {
        return;
    }

    providerLogger.error("[ChatProvider] Media generation failed", { result });
    onRefused?.();
    reportThreadError(media.threadId, mediaGenerationError(result, networkMessage()));
};
