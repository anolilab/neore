"use client";

import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityKey } from "@neore/backend/source-control/capabilities";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import { Badge } from "@neore/ui/components/badge";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import { ExternalLink } from "lucide-react";
import { useState } from "react";

import { safeExternalUrl } from "../lib/format";
import type { DevelopTab } from "../lib/search";
import { DEVELOP_TABS } from "../lib/search";
import { usePullRequest } from "../lib/use-develop";
import { useRequestNoun } from "../lib/use-request-noun";
import ChecksTab from "./checks-tab";
import CommitsTab from "./commits-tab";
import FailureNotice from "./failure-notice";
import FilesTab from "./files-tab";
import GuideTab from "./guide-tab";
import type { HostInfo } from "./host-info";
import MergePanel from "./merge-panel";
import ReviewPanel from "./review-panel";
import WorkOnPullRequest from "./work-on-pull-request";

const TAB_CAPABILITY: Record<DevelopTab, HostCapabilityKey> = {
    checks: "pullRequest.checks",
    commits: "pullRequest.commits",
    description: "pullRequest.description",
    files: "pullRequest.files",
    guide: "pullRequest.guide",
};

const PullRequestView = ({
    host,
    number,
    onTabChange,
    repository,
    tab,
}: {
    host: HostInfo;
    number: number;
    onTabChange: (tab: DevelopTab) => void;
    repository: string;
    tab: DevelopTab | undefined;
}) => {
    const { t } = useLingui();
    const requestNoun = useRequestNoun(host.requestNoun);
    const address = { number, repository };
    const pull = usePullRequest(address);
    // A file the guide pointed at: the Files tab opens it. The token makes a second click on the same file act again.
    const [focus, setFocus] = useState<{ path: string; token: number } | null>(null);

    if (pull.isPending) {
        return <Skeleton aria-label={t`Loading`} className="h-40 w-full" role="status" />;
    }

    if (pull.isError) {
        return <FailureNotice label={host.label} status="host_error" />;
    }

    if (pull.data.status !== "ok") {
        return <FailureNotice label={host.label} status={pull.data.status} />;
    }

    const { detail, leftOut } = pull.data;
    // In the declared order, so a pull request opens on its description.
    const tabs = DEVELOP_TABS.filter((candidate) => isHostCapabilityAvailable(host.capabilities, TAB_CAPABILITY[candidate]));
    const current = tab !== undefined && tabs.includes(tab) ? tab : tabs[0];
    const tabLabels: Record<DevelopTab, string> = { checks: t`Checks`, commits: t`Commits`, description: t`Description`, files: t`Files`, guide: t`Guide` };
    const stateLabels = { closed: t`Closed`, merged: t`Merged`, open: t`Open` };
    const href = safeExternalUrl(detail.url);

    return (
        <article aria-labelledby="develop-pr-title" className="space-y-4">
            <header className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                    <Badge variant={detail.state === "open" ? "default" : "secondary"}>
                        {detail.draft && detail.state === "open" ? t`Draft` : stateLabels[detail.state]}
                    </Badge>
                    <span className="text-muted-foreground text-xs">
                        {detail.repository}#{detail.number}
                    </span>
                    {href && (
                        <a
                            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs hover:underline"
                            href={href}
                            rel="noopener noreferrer"
                            target="_blank"
                        >
                            {t`Open on ${host.label}`}
                            <ExternalLink aria-hidden className="size-3" />
                        </a>
                    )}
                </div>
                <h2 className="text-lg font-semibold break-words" id="develop-pr-title">
                    {detail.title}
                </h2>
                <p className="text-muted-foreground text-sm">
                    {t`${detail.authorLogin} wants to merge ${plural(detail.commitCount, { one: "# commit", other: "# commits" })} into ${detail.baseBranch} from ${detail.headBranch}`}
                </p>
                <p className="text-sm">
                    <span className="font-mono text-emerald-600 dark:text-emerald-400">+{detail.additions}</span>{" "}
                    <span className="font-mono text-red-600 dark:text-red-400">−{detail.deletions}</span>{" "}
                    <span className="text-muted-foreground">{t`in ${plural(detail.changedFiles, { one: "# file", other: "# files" })}`}</span>
                </p>
            </header>
            <WorkOnPullRequest
                address={address}
                baseBranch={detail.baseBranch}
                canStart={detail.state === "open"}
                headBranch={detail.headBranch}
                requestNoun={requestNoun}
            />
            {detail.state === "open" && !detail.draft && (
                <MergePanel address={address} capabilities={host.capabilities} headSha={detail.headSha} hostLabel={host.label} requestNoun={requestNoun} />
            )}
            <ReviewPanel address={address} capabilities={host.capabilities} headSha={detail.headSha} hostLabel={host.label} />
            {current === undefined ? (
                <p className="text-muted-foreground text-sm">{t`This host does not offer any view of a ${requestNoun} yet.`}</p>
            ) : (
                <Tabs onValueChange={(value) => onTabChange(value as DevelopTab)} value={current}>
                    <TabsList aria-label={t`${requestNoun} views`}>
                        {tabs.map((candidate) => (
                            <TabsTrigger key={candidate} value={candidate}>
                                {tabLabels[candidate]}
                            </TabsTrigger>
                        ))}
                    </TabsList>
                    <TabsContent className="pt-3" value="description">
                        {/* The body is text from the host: shown as text, line breaks kept, never parsed as markup. */}
                        <pre className="font-sans text-sm break-words whitespace-pre-wrap">
                            {detail.body === "" ? t`No description provided.` : detail.body}
                        </pre>
                        {detail.bodyTruncated && <p className="text-muted-foreground mt-2 text-xs">{t`The description is cut short.`}</p>}
                    </TabsContent>
                    <TabsContent className="pt-3" value="commits">
                        {current === "commits" && (
                            <CommitsTab address={address} commitLimit={host.limits.commits} hostLabel={host.label} leftOut={leftOut.commits} />
                        )}
                    </TabsContent>
                    <TabsContent className="pt-3" value="files">
                        {current === "files" && (
                            <FilesTab
                                address={address}
                                capabilities={host.capabilities}
                                fileCount={detail.changedFiles}
                                fileLimit={host.limits.files}
                                focus={focus}
                                headSha={detail.headSha}
                                hostLabel={host.label}
                                leftOut={leftOut.files}
                                showDiff={isHostCapabilityAvailable(host.capabilities, "pullRequest.diff")}
                            />
                        )}
                    </TabsContent>
                    <TabsContent className="pt-3" value="guide">
                        {current === "guide" && (
                            <GuideTab
                                address={address}
                                headSha={detail.headSha}
                                hostLabel={host.label}
                                onOpenFile={(path) => {
                                    setFocus({ path, token: Date.now() });
                                    onTabChange("files");
                                }}
                                requestNoun={requestNoun}
                            />
                        )}
                    </TabsContent>
                    <TabsContent className="pt-3" value="checks">
                        {current === "checks" && (
                            <ChecksTab address={address} capabilities={host.capabilities} headSha={detail.headSha} hostLabel={host.label} />
                        )}
                    </TabsContent>
                </Tabs>
            )}
        </article>
    );
};

export default PullRequestView;
