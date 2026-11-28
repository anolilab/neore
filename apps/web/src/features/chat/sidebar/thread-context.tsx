import { useLingui } from "@lingui/react/macro";
import type { ThreadPermissionMode } from "@neore/backend/chat/permission-mode";
import { useUnlockProof } from "@neore/client-runtime";
import cn from "@neore/ui/utils/cn";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { Brain, Coins, FolderKanban, GitPullRequest, Monitor, ShieldCheck, Sparkles, Target } from "lucide-react";
import type { FC, ReactNode } from "react";

import { formatTokenCount } from "@/components/model-picker/utilities";
import useThreadUsage from "@/features/chat/core/hooks/use-thread-usage";
import { useThreadGoal } from "@/features/chat/goal/use-thread-goal";
import { useShownPermissionMode } from "@/features/chat/thread/composer-permission-mode";
import ThreadPullRequests from "@/features/develop/components/thread-pull-requests";
import { useProject } from "@/features/projects/hooks/use-projects";
import useCachedModelName from "@/hooks/use-cached-model-name";
import { useCRPC } from "@/lib/lunora/crpc";

/** What the box reads off the thread record the Thread tab already holds. */
export interface ThreadContextRecord {
    /** After an agent switch, the agent's model is the one the thread runs on. */
    activeAgent?: { model?: string };
    autoModel?: boolean;
    model?: string;
    projectId?: string;
    runner?: string;
}

const Row: FC<{ children: ReactNode; className?: string; icon: LucideIcon; label: string }> = ({ children, className, icon: Icon, label }) => (
    <div className={cn("flex min-w-0 items-start gap-2.5 px-3 py-2 not-first:border-border/50 not-first:border-t", className)}>
        <Icon aria-hidden="true" className="text-muted-foreground mt-0.5 size-4 shrink-0" />
        <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-xs">{label}</div>
            <div className="min-w-0 text-sm break-words">{children}</div>
        </div>
    </div>
);

/**
 * Where the thread runs and what it is set to, at the top of the Thread tab: the computer, folder and agent of a thread that
 * runs on your computer, its linked pull requests, the goal, the model or Auto, the permission mode, the project and the tokens
 * it used. Only the rows that apply are drawn.
 */
const ThreadContext: FC<{ thread: ThreadContextRecord; threadId: string }> = ({ thread, threadId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const isHostRun = thread.runner === "host";
    const { data: hostSession } = useQuery(crpc.acp.functions.getHostSession.queryOptions(isHostRun ? { threadId } : skipToken));
    const devices = useQuery(crpc.devices.functions.listDevices.queryOptions(hostSession ? {} : skipToken));
    // The header's pull request control asks the same, so this shares its answer: only the owner has a row there.
    const unlockProof = useUnlockProof(threadId);
    const { data: access } = useQuery(crpc.chat.sharing.getThreadAccess.queryOptions({ threadId: threadId as never, unlockProof }));
    const goal = useThreadGoal(threadId);
    const usage = useThreadUsage(threadId);
    const permissionMode = useShownPermissionMode();
    const project = useProject(thread.projectId as never);
    // The model the composer and the next turn use: the active agent's, and Auto only without one (`use-model-combobox.ts`).
    const model = thread.activeAgent?.model ?? thread.model;
    const isAuto = thread.autoModel === true && !thread.activeAgent;
    const modelName = useCachedModelName(model);

    const permissionLabels: Record<ThreadPermissionMode, string> = {
        auto: t`Auto`,
        full: t`Full access`,
        supervised: t`Supervised`,
    };
    // "Device removed" only once the list has answered without it; while it loads, or if it failed, the folder stands alone.
    const deviceName = devices.isSuccess ? (devices.data.find((device) => device._id === hostSession?.deviceId)?.name ?? t`Device removed`) : undefined;
    const totalTokens = usage?.totalTokens ?? 0;

    return (
        <section aria-label={t`Context`} className="surface-raised overflow-hidden rounded-xl" data-slot="thread-context">
            {hostSession && (
                <Row icon={Monitor} label={t`Computer`}>
                    {/* A device revoked since keeps its session readable: say so rather than show the folder as the computer. */}
                    {deviceName !== undefined && <span className="me-1.5 font-medium">{deviceName}</span>}
                    <span className="text-muted-foreground font-mono text-xs">{hostSession.folderLabel}</span>
                    <span className="text-muted-foreground block text-xs">
                        {hostSession.agentLabel}
                        {hostSession.liveStreamId && (
                            <>
                                {" · "}
                                {/* A turn is live from the moment it is sent, before the computer picks it up: "In progress" covers both. */}
                                <span className="text-primary-text">{t`In progress`}</span>
                            </>
                        )}
                    </span>
                </Row>
            )}

            {/* Linked pull requests and the Link button, as in the header; keyed so a thread switch starts fresh. Owner only, as there. */}
            {access?.isOwner === true && (
                <Row icon={GitPullRequest} label={t`Pull requests`}>
                    <ThreadPullRequests key={threadId} threadId={threadId} />
                </Row>
            )}

            {goal && (
                <Row icon={Target} label={t`Goal`}>
                    <span className="line-clamp-2">{goal.text}</span>
                    <span className="text-muted-foreground block font-mono text-xs tabular-nums">
                        {/* `round` counts finished rounds: an active goal is on the next one, as the goal note says. */}
                        {goal.status === "active" ? Math.min(goal.round + 1, goal.maxRounds) : goal.round}/{goal.maxRounds}
                    </span>
                </Row>
            )}

            {/* A thread on your computer runs the coding agent's own model; the agent row above says which. */}
            {!isHostRun && (model || isAuto) && (
                <Row icon={isAuto ? Sparkles : Brain} label={t`Model`}>
                    {isAuto ? t`Auto` : (modelName ?? model)}
                </Row>
            )}

            {permissionMode && (
                <Row icon={ShieldCheck} label={t`Permission mode`}>
                    {permissionLabels[permissionMode]}
                </Row>
            )}

            {project && (
                <Row icon={FolderKanban} label={t`Project`}>
                    {project.title}
                </Row>
            )}

            {totalTokens > 0 && (
                <Row icon={Coins} label={t`Tokens`}>
                    <span className="font-mono tabular-nums">{formatTokenCount(totalTokens, i18n.locale)}</span>
                </Row>
            )}
        </section>
    );
};

export default ThreadContext;
