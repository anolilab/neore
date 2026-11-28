import type { ThreadDoc } from "../../agent/validators";

/**
 * The tags of the chats a person types into: the composer's (`chat`), a local model's (`local`) and a coding agent's on
 * a paired computer (`host`). A chat whose tags are all of these, `chat` among them, holds the person's typed prompts.
 * Every other kind does not, whatever its tags. Their app-written prompts (a sub-agent's or worker's brief, a task's
 * instructions, a trigger's template, an eval case, a pull request chat's opening message) are saved with no `typedText`
 * (`appWrittenTextPart`), but rows saved before that mark still carry it, so the kind still tells them apart, and a kind
 * added later stays out until it is listed here.
 */
const TYPED_CHAT_TAGS: ReadonlySet<string> = new Set(["chat", "host", "local"]);

/** Whether a tagged chat is one a person types into ({@link TYPED_CHAT_TAGS}); a messenger chat never is. */
export const isTypedChatKind = (thread: Pick<ThreadDoc, "externalThreadId" | "messengerConnectionId" | "tags">): boolean => {
    const tags = thread.tags ?? [];

    return (
        thread.externalThreadId === undefined &&
        thread.messengerConnectionId === undefined &&
        tags.includes("chat") &&
        tags.every((tag) => TYPED_CHAT_TAGS.has(tag))
    );
};
