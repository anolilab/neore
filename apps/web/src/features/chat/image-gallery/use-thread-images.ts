import type { ThreadImage } from "@neore/chat-ui/utils/thread-images";
import { collectThreadImages } from "@neore/chat-ui/utils/thread-images";
import { useMemo } from "react";

import { useChatMessages } from "@/features/chat/core/context/chat-context-hooks";

/** The images of the chat's loaded messages. A streamed batch scans only the streaming message again (`collectThreadImages`). */
const useThreadImages = (): ReadonlyArray<ThreadImage> => {
    const { messages } = useChatMessages();

    return useMemo(() => collectThreadImages(messages), [messages]);
};

export default useThreadImages;
