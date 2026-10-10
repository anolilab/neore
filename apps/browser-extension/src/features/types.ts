import type { PageContext } from "@/page-context/build";

/** What a chat opens with: an attached page and, for quick prompts, text to send at once. */
export interface ChatSeed {
    autoSend?: string;
    /** Changes for every seed, so the same page can be attached twice. */
    id: string;
    pageContext?: PageContext;
}

export type View =
    | { type: "threads" }
    /** `key` remounts the chat for a new conversation but survives the new thread getting its id. */
    | { key: string; seed?: ChatSeed; threadId: string | null; type: "chat" }
    | { type: "settings" };
