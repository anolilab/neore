import type { ThreadImage } from "@neore/chat-ui/utils/thread-images";
import { collectThreadImages } from "@neore/chat-ui/utils/thread-images";
import { useMemo } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context-hooks";

/**
 * The messages whose images the gallery lists: while a reply streams, the message list shows a placeholder instead of
 * its unfinished last assistant message (`message-list.tsx`), so its images wait until it is done.
 */
export const galleryMessages = <T extends { role: string; status?: string }>(messages: ReadonlyArray<T>, isStreaming: boolean): ReadonlyArray<T> => {
    const last = messages.at(-1);

    return isStreaming && last?.role === "assistant" && last.status !== "success" ? messages.slice(0, -1) : messages;
};

/** The images of the chat's loaded messages. A streamed batch scans only the streaming message again (`collectThreadImages`). */
const useThreadImages = (): ReadonlyArray<ThreadImage> => {
    const { isStreaming, messages } = useChatMessages();

    return useMemo(() => collectThreadImages(galleryMessages(messages, isStreaming)), [isStreaming, messages]);
};

export default useThreadImages;
