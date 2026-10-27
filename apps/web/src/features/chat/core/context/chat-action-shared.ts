import type { Dispatch, RefObject, SetStateAction } from "react";

import type { UIMessage } from "@/lib/agent";
import { AppError, ErrorFactory } from "@/lib/errors";

import type { PendingSettings } from "../stores/model-store";

const HTTP_STATUS_RE = /HTTP (\d+)/;

/** Turns whatever a send, reload or edit threw into the `AppError` the chat shows. */
export const toAppError = (error_: unknown): AppError => {
    let appError: AppError;

    if (error_ instanceof Response) {
        appError = ErrorFactory.fromResponse(error_);
    } else if (error_ instanceof Error) {
        // Check if it's already an AppError
        if ("code" in error_ && "statusCode" in error_) {
            appError = error_ as AppError;
        } else {
            // Convert HTTP error messages
            const statusMatch = error_.message.match(HTTP_STATUS_RE);

            if (statusMatch?.[1]) {
                const status = Number(statusMatch[1]);

                appError = ErrorFactory.fromResponse(new Response(null, { status }));
            } else {
                appError = ErrorFactory.fromBackendError(error_);
            }
        }
    } else {
        appError = ErrorFactory.fromBackendError(error_);
    }

    return appError;
};

/** State updater dropping one message by id. */
export const withoutMessage =
    (id: string) =>
    (previous: UIMessage[]): UIMessage[] =>
        previous.filter((m) => m.id !== id);

/** State updater un-hiding optimistically hidden message ids. */
export const unhiding =
    (ids: ReadonlyArray<string>) =>
    (previous: Set<string>): Set<string> =>
        new Set([...previous].filter((id) => !ids.includes(id)));

/** An `AppError` passes through `handleError` untouched: a local message may name the LOCAL server's HTTP status. */
export const localModelError = (message: string): AppError => new AppError(message, { code: "LOCAL_MODEL_ERROR", statusCode: 502 });

/** The reply stream this provider started, for `cancelStream` to abort. */
export type StreamingMessage = { gatewayUrl?: string; messageId: string; streamId?: string; streamToken?: string; threadId: string };

/** The pending settings that differ from the thread's own, as `getChangedSettings` returns them. */
export type ChangedSettings = Pick<PendingSettings, "customSystemPrompt" | "enabledFeatures" | "language" | "reasoningEffort" | "statelessMode">;

/**
 * The provider values every send, reload and edit body closes over. The bodies
 * live in sibling files but run inside the provider's own `useCallback`s, which
 * keep their dependency arrays; refs are passed whole because the bodies read
 * them AFTER an await.
 */
export interface ChatActionBase {
    authHeader: () => Record<string, string>;
    handleError: (error: unknown) => void;
    messagesRef: RefObject<UIMessage[]>;
    setError: Dispatch<SetStateAction<AppError | null>>;
    setIsRegenerating: Dispatch<SetStateAction<boolean>>;
    streamingMessageRef: RefObject<StreamingMessage | null>;
    threadId: string | undefined;
}
