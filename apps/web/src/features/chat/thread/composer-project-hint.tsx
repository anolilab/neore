/**
 * ComposerProjectHint - a quiet chip under the composer while the first message of a new thread is typed. It names the
 * project whose title, or whose recent thread titles, match the draft. A click picks that project; the first send files
 * the new thread there. Matching is local (`matchProjectHint`): no model call.
 */
import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { CheckIcon, FolderIcon } from "lucide-react";
import type { FC } from "react";
import { useDeferredValue, useMemo } from "react";

import { useUserSettings } from "@/features/auth/hooks/use-user-settings";
import { useChatThread } from "@/features/chat/core/context/chat-context";
import { useThreads } from "@/features/chat/core/hooks/use-threads";
import { selectComposerText, useChatUIStore } from "@/features/chat/core/stores/chat-ui-store";
import { selectPendingSettings, selectSetPendingSettings, useModelStore } from "@/features/chat/core/stores/model-store";
import { newChatTemporaryFields } from "@/features/chat/core/utils/new-chat-temporary";
import { useProjects } from "@/features/projects/hooks/use-projects";

import { matchProjectHint } from "./project-hint-match";

("use client");

const ProjectHintChip: FC = () => {
    const { t } = useLingui();
    const draft = useChatUIStore(selectComposerText);
    const pendingProjectId = useModelStore((state) => state.pendingSettings?.projectId);
    const setPendingSettings = useModelStore(selectSetPendingSettings);
    const projects = useProjects();
    const threads = useThreads();
    // The draft is matched once typing has settled, so a long thread list is not searched on every key.
    const deferredDraft = useDeferredValue(draft);

    const selectedProject = useMemo(() => projects.find((project) => project._id === pendingProjectId), [projects, pendingProjectId]);
    const matchedProject = useMemo(() => matchProjectHint(deferredDraft, projects, threads), [deferredDraft, projects, threads]);

    // A temporary chat is not filed in any project (the send skips it), so no project is offered for it. The pick stays
    // in the store, so the chip comes back with it when the chat is made lasting again.
    const { data: userSettings } = useUserSettings();
    const pendingSettings = useModelStore(selectPendingSettings);
    const temporary = newChatTemporaryFields(pendingSettings, userSettings?.newChatsTemporary === true) !== undefined;

    // A stored pick is what the send files the thread in, so while it is stored the chip shows it, even when the project is
    // not in the list (archived, removed, or not loaded yet). Only with no pick stored does the draft's match get offered.
    const isSelected = pendingProjectId !== undefined;
    const shown = isSelected ? selectedProject : matchedProject;

    if (temporary || (!isSelected && !shown)) {
        return null;
    }

    const togglePick = () => {
        setPendingSettings((previous) => {
            return { ...previous, projectId: isSelected ? undefined : shown?._id };
        });
    };

    // The label names the project and does not change with the pick: the pressed state says whether it is picked.
    const label = shown ? t`File in ${shown.title}` : t`File in another project`;

    return (
        <div className="flex px-2 pb-2">
            <button
                aria-pressed={isSelected}
                className={cn(
                    "flex max-w-xs cursor-pointer items-center gap-1.5 rounded-full border px-3 py-1 text-left text-xs transition-colors outline-none",
                    "border-border/60 bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground",
                    "focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-1",
                    isSelected && "border-primary/50 text-foreground",
                )}
                onClick={togglePick}
                type="button"
            >
                {isSelected ? (
                    <CheckIcon aria-hidden="true" className="size-3 shrink-0" />
                ) : (
                    <FolderIcon aria-hidden="true" className="size-3 shrink-0 opacity-60" />
                )}
                <span className="truncate">{label}</span>
            </button>
        </div>
    );
};

/** Mounted only for a new thread, so the project and thread lists are not subscribed to on an existing one. */
const ComposerProjectHint: FC = () => {
    const { isNewThread } = useChatThread();

    if (!isNewThread) {
        return null;
    }

    return <ProjectHintChip />;
};

export default ComposerProjectHint;
