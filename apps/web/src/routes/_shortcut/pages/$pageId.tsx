import { createFileRoute } from "@tanstack/react-router";

import PageView from "@/features/pages/components/page-view";
import { usePageShard } from "@/features/pages/hooks/use-page-shard";

const PageRoute = () => {
    const { pageId } = Route.useParams();
    // A page shared with the caller lives on its owner's shard; settle that first.
    const shardReady = usePageShard(pageId);

    if (!shardReady) {
        return null;
    }

    // Keyed: every page gets a fresh editor, presence session and version bookkeeping.
    return <PageView key={pageId} pageId={pageId} />;
};

export const Route = createFileRoute("/_shortcut/pages/$pageId")({
    component: PageRoute,
});
