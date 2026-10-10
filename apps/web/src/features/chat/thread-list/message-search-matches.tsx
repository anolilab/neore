import { useLingui } from "@lingui/react/macro";
import { useRouter } from "@tanstack/react-router";
import { CornerDownRightIcon } from "lucide-react";
import type { FC } from "react";

import { scrollToMessage } from "@/features/chat/thread/message-list";

import { buildMatchSnippet } from "./utilities";

/** Enough to tell the hits apart without turning one result into a wall of text. */
const MAX_VISIBLE_MATCHES = 3;

interface RelevantMessage {
    _id: string;
    order: number;
    stepOrder: number;
    text?: string;
}

interface MessageSearchMatchesProps {
    matches: RelevantMessage[];
    searchQuery: string;
    threadId: string;
}

/**
 * The matching messages under a message-search result. Each opens the thread and
 * jumps to (and focuses) that message, loading older pages if it is not loaded.
 * Rendered outside the row's own `role="button"` so the buttons do not nest.
 */
const MessageSearchMatches: FC<MessageSearchMatchesProps> = ({ matches, searchQuery, threadId }) => {
    const { t } = useLingui();
    const router = useRouter();
    const visible = matches.filter((match) => match.text?.trim()).slice(0, MAX_VISIBLE_MATCHES);

    if (visible.length === 0) {
        return null;
    }

    const handleOpen = (match: RelevantMessage) => {
        void router.navigate({ hash: `message-${match._id}`, params: { threadId }, search: {}, to: "/chat/$threadId" });
        scrollToMessage(match._id, { position: { order: match.order, stepOrder: match.stepOrder }, threadId });
    };

    return (
        <ul aria-label={t`Matching messages`} className="mt-0.5 mb-1 ml-5 flex flex-col gap-0.5">
            {visible.map((match) => {
                const snippet = buildMatchSnippet(match.text ?? "", searchQuery);

                return (
                    <li key={match._id}>
                        <button
                            aria-label={t`Go to message: ${snippet}`}
                            className="text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-ring/50 flex w-full min-w-0 items-start gap-1 rounded px-1.5 py-0.5 text-left text-xs outline-none focus-visible:ring-2"
                            onClick={() => handleOpen(match)}
                            type="button"
                        >
                            <CornerDownRightIcon aria-hidden="true" className="mt-0.5 size-3 shrink-0" />
                            <span className="line-clamp-2 break-words">{snippet}</span>
                        </button>
                    </li>
                );
            })}
        </ul>
    );
};

export default MessageSearchMatches;
