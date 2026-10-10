import { usePaginatedQuery, useQuery } from "@lunora/react";
import { api } from "@neore/backend/api";
import OrgSwitcher from "@neore/chat-ui/org-switcher/org-switcher";
import ThreadList from "@neore/chat-ui/threads/thread-list";
import type { Thread } from "@neore/chat-ui/types";
import { SettingsIcon } from "lucide-react";

import { useSession } from "@/lib/session";

interface ThreadsPageProps {
    activeOrgId: string | null;
    onNewChat: () => void;
    onOpenSettings: () => void;
    onSelectThread: (threadId: string) => void;
    setActiveOrgId: (orgId: string | null) => void;
}

export function ThreadsPage({ activeOrgId, onNewChat, onOpenSettings, onSelectThread, setActiveOrgId }: ThreadsPageProps) {
    const { data: session } = useSession();

    const { loadMore, results, status } = usePaginatedQuery(
        api.chat.functions.getThreads,
        { excludeTemporary: true, organizationId: activeOrgId ?? undefined },
        { initialNumItems: 30 },
    );

    const orgsResult = useQuery(api.auth.organization.listOrganizations, {});

    const threads: Thread[] = (results ?? []).map((thread) => {
        return {
            _creationTime: thread._creationTime,
            _id: thread._id,
            mode: thread.mode,
            model: thread.model,
            organizationId: thread.organizationId,
            pinnedAt: thread.pinnedAt,
            source: thread.source,
            status: thread.status,
            title: thread.title,
        };
    });

    const organizations = (orgsResult?.organizations ?? []).map((organization) => {
        return {
            id: organization.id,
            logo: organization.logo ?? undefined,
            name: organization.name,
            slug: organization.slug,
        };
    });

    return (
        <div className="flex h-full flex-col">
            <header className="flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 px-3 py-2 dark:border-gray-800">
                <h1 className="text-sm font-semibold text-gray-800 dark:text-gray-100">Anole Chat</h1>
                <div className="flex items-center gap-1">
                    <OrgSwitcher
                        activeOrgId={activeOrgId}
                        currentUser={{
                            email: session?.user.email ?? "",
                            image: session?.user.image ?? undefined,
                            name: session?.user.name ?? undefined,
                        }}
                        onOpenSettings={onOpenSettings}
                        onSwitch={setActiveOrgId}
                        organizations={organizations}
                        size="sm"
                    />
                    <button
                        aria-label="Settings"
                        className="flex size-7 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700 focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:outline-none dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200"
                        onClick={onOpenSettings}
                        type="button"
                    >
                        <SettingsIcon aria-hidden="true" className="size-4" />
                    </button>
                </div>
            </header>
            <main className="min-h-0 flex-1">
                <ThreadList
                    hasMore={status === "CanLoadMore"}
                    isLoading={status === "LoadingFirstPage"}
                    onCreateThread={onNewChat}
                    onLoadMore={() => loadMore(20)}
                    onSelect={onSelectThread}
                    threads={threads}
                />
            </main>
        </div>
    );
}
