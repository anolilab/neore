"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { FolderKanban } from "lucide-react";
import type { FC } from "react";

import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useProject } from "@/features/projects/hooks/use-projects";

import ComposerChip from "./composer-chip";
import ComposerProjectHint from "./composer-project-hint";

/** The project an existing chat is filed in, as a quiet chip. Nothing for a chat in no project. */
const ThreadProjectChip: FC<{ projectId: Id<"projects"> }> = ({ projectId }) => {
    const { t } = useLingui();
    const project = useProject(projectId);

    if (!project) {
        return null;
    }

    return (
        <div aria-label={t`Context`} className="flex flex-wrap items-center gap-1.5" role="group">
            <ComposerChip>
                <FolderKanban aria-hidden="true" className="size-3 shrink-0" />
                <span className="sr-only">{t`Project`}</span>
                <span className="truncate">{project.title}</span>
            </ComposerChip>
        </div>
    );
};

/**
 * What sits under the composer panel in a chat: where the chat is filed. A new chat offers the project its draft matches (a
 * choice); a chat that exists shows the project it is in. In a chat with neither, the row renders nothing and the panel hides it.
 * `busy` holds the new-chat choice back while the first message goes out.
 */
const ComposerContext: FC<{ busy: boolean }> = ({ busy }) => {
    const { isNewThread, thread } = useChatThread();

    if (isNewThread) {
        return busy ? null : <ComposerProjectHint />;
    }

    return thread?.projectId ? <ThreadProjectChip projectId={thread.projectId as Id<"projects">} /> : null;
};

export default ComposerContext;
