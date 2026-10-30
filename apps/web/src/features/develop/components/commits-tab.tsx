"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Skeleton } from "@neore/ui/components/skeleton";

import { commitSubject, shortSha } from "../lib/format";
import type { PullRequestAddress } from "../lib/use-develop";
import { usePullRequestCommits } from "../lib/use-develop";
import FailureNotice from "./failure-notice";

const CommitsTab = ({ address, commitLimit, hostLabel, leftOut }: { address: PullRequestAddress; commitLimit: number; hostLabel: string; leftOut: number }) => {
    const { t } = useLingui();
    const commits = usePullRequestCommits(address, true);

    if (commits.isPending) {
        return <Skeleton aria-label={t`Loading commits`} className="h-24 w-full" role="status" />;
    }

    const pages = commits.data?.pages ?? [];
    const listed = pages.flatMap((page) => (page.status === "ok" ? page.commits : []));
    const failed = pages.find((page) => page.status !== "ok");
    const failure = failed?.status ?? (commits.isError ? "host_error" : undefined);

    // A later page that fails leaves the earlier ones on screen, with the failure below them.
    if (failure && listed.length === 0) {
        return <FailureNotice label={hostLabel} status={failure} />;
    }

    return (
        <div className="space-y-3">
            {leftOut > 0 && (
                <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm" role="note">
                    {t`The host lists at most ${plural(commitLimit, { one: "# commit", other: "# commits" })} for one change. ${plural(leftOut, { one: "# more is not shown here.", other: "# more are not shown here." })}`}
                </p>
            )}
            <ol className="rounded-md border">
                {listed.map((commit) => (
                    <li className="flex items-baseline gap-3 border-b px-3 py-2 text-sm last:border-b-0" key={commit.sha}>
                        <code className="text-muted-foreground shrink-0 font-mono text-xs">{shortSha(commit.sha)}</code>
                        <span className="min-w-0 flex-1 truncate">{commitSubject(commit.message)}</span>
                        <span className="text-muted-foreground shrink-0 text-xs">{commit.authorName}</span>
                    </li>
                ))}
            </ol>
            {failure && <FailureNotice label={hostLabel} status={failure} />}
            {commits.hasNextPage && !failure && (
                <Button disabled={commits.isFetchingNextPage} onClick={() => commits.fetchNextPage()} variant="outline">
                    {t`Load more commits`}
                </Button>
            )}
        </div>
    );
};

export default CommitsTab;
