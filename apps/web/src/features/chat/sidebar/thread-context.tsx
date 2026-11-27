import { useLingui } from "@lingui/react/macro";
import type { ThreadPermissionMode } from "@neore/backend/chat/permission-mode";
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
    const { data: devices } = useQuery(crpc.devices.functions.listDevices.queryOptions(hostSession ? {} : skipToken));
    const goal = useThreadGoal(threadId);
    const usage = useThreadUsage(threadId);
    const permissionMode = useShownPermissionMode();
    const project = useProject(thread.projectId as never);
    const modelName = useCachedModelName(thread.model);

    const permissionLabels: Record<ThreadPermissionMode, string> = {
        auto: t`Auto`,
        full: t`Full access`,
        supervised: t`Supervised`,
    };
    const deviceName = hostSession ? devices?.find((device) => device._id === hostSession.deviceId)?.name : undefined;
    const totalTokens = usage?.totalTokens ?? 0;

    return (
        <section aria-label={t`Context`} className="surface-raised overflow-hidden rounded-xl" data-slot="thread-context">
            {hostSession && (
                <Row icon={Monitor} label={t`Computer`}>
                    <span className="font-medium">{deviceName ?? hostSession.folderLabel}</span>
                    {deviceName && <span className="text-muted-foreground ms-1.5 font-mono text-xs">{hostSession.folderLabel}</span>}
                    <span className="text-muted-foreground block text-xs">
                        {hostSession.agentLabel}
                        {hostSession.liveStreamId && (
                            <>
                                {" · "}
                                <span className="text-primary-text">{t`Running`}</span>
                            </>
                        )}
                    </span>
                </Row>
            )}

            {/* Linked pull requests and the Link button, as in the header; keyed so a thread switch starts fresh. */}
            {!isHostRun || hostSession ? (
                <Row icon={GitPullRequest} label={t`Pull requests`}>
                    <ThreadPullRequests key={threadId} threadId={threadId} />
                </Row>
            ) : null}

            {goal && (
                <Row icon={Target} label={t`Goal`}>
                    <span className="line-clamp-2">{goal.text}</span>
                    <span className="text-muted-foreground block font-mono text-xs tabular-nums">
                        {goal.round}/{goal.maxRounds}
                    </span>
                </Row>
            )}

            {/* A thread on your computer runs the coding agent's own model; the agent row above says which. */}
            {!isHostRun && (thread.model || thread.autoModel) && (
                <Row icon={thread.autoModel ? Sparkles : Brain} label={t`Model`}>
                    {thread.autoModel ? t`Auto` : (modelName ?? thread.model)}
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
