import { msg } from "@lingui/core/macro";
import { api } from "@neore/backend/api";
import { createFileRoute } from "@tanstack/react-router";

import type { PublicThread } from "@/features/chat/sharing/public-thread-message";
import type { SharedThreadStatus } from "@/features/chat/sharing/shared-thread-page";
import SharedThreadPage from "@/features/chat/sharing/shared-thread-page";
import { createLunoraActionQueryOptions } from "@/lib/lunora/crpc";
import { seo } from "@/lib/seo";

interface SharedThreadLoaderData {
    description: string;
    status: SharedThreadStatus;
    thread: PublicThread | null;
    title: string;
}

const SharedThreadRoute = () => {
    const { status, thread } = Route.useLoaderData();

    return <SharedThreadPage status={status} thread={thread} />;
};

export const Route = createFileRoute("/(public)/thread/$token")({
    component: SharedThreadRoute,
    // A share is a snapshot: re-running the loader on every focus buys nothing.
    staleTime: 60_000,
    loader: async ({ context, params }): Promise<SharedThreadLoaderData> => {
        const { i18n } = context;
        const description = i18n._(msg`A conversation shared from Neore Chat.`);

        try {
            // Loaded here rather than in the component so SSR can put the title in
            // <head>. An action: the thread lives on its owner's shard, which the
            // server resolves from the token and reads as the system.
            const thread = await context.queryClient.fetchQuery(
                createLunoraActionQueryOptions(context.lunoraClient, api.chat.sharing.getPublicThread, { publicAccessToken: params.token }),
            );

            if (!thread) {
                return { description, status: "unavailable", thread: null, title: i18n._(msg`Conversation not available`) };
            }

            return { description, status: "ok", thread, title: thread.title ?? i18n._(msg`Shared conversation`) };
        } catch {
            return { description, status: "error", thread: null, title: i18n._(msg`Shared conversation`) };
        }
    },
    head: ({ loaderData, match }) => {
        return {
            // No canonical and no og:url pointing at the token: the link is a
            // bearer credential, and noindex keeps it out of search results.
            meta: seo({
                description: loaderData?.description,
                noIndex: true,
                title: loaderData?.title ?? match.context.i18n._(msg`Shared conversation`),
            }),
        };
    },
});
