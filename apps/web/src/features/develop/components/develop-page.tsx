"use client";

import { useLingui } from "@lingui/react/macro";
import { isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import type { InboxSection } from "@neore/backend/source-control/types";
import { Skeleton } from "@neore/ui/components/skeleton";

import type { DevelopSearch, DevelopTab } from "../lib/search";
import { useDevelopHost } from "../lib/use-develop";
import { useRequestNoun } from "../lib/use-request-noun";
import ConnectHostCard from "./connect-host-card";
import FailureNotice from "./failure-notice";
import type { HostInfo } from "./host-info";
import InboxList, { availableSections } from "./inbox-list";
import PullRequestView from "./pull-request-view";
import WatchedRepositories from "./watched-repositories";

/**
 * The Develop page: the inbox on the left, one pull request on the right. What it shows is
 * decided by the host's capability report; it never looks at which host that is.
 */
const DevelopPage = ({ onSearchChange, search }: { onSearchChange: (next: DevelopSearch) => void; search: DevelopSearch }) => {
    const { t } = useLingui();
    const hostQuery = useDevelopHost();
    const requestNoun = useRequestNoun(hostQuery.data?.host.requestNoun ?? "pull request");

    if (hostQuery.isPending) {
        return <Skeleton aria-label={t`Loading`} className="mx-auto h-40 max-w-7xl" role="status" />;
    }

    if (hostQuery.isError) {
        return <FailureNotice label={t`The host`} status="host_error" />;
    }

    const { connected, host } = hostQuery.data;
    const info: HostInfo = host;
    const sections = availableSections(info);
    const section: InboxSection | undefined = search.section !== undefined && sections.includes(search.section) ? search.section : sections[0];
    const selected = search.repository !== undefined && search.number !== undefined ? { number: search.number, repository: search.repository } : undefined;

    return (
        <div className="mx-auto max-w-7xl space-y-6">
            <header className="space-y-1">
                <h1 className="text-xl font-semibold">{t`Develop`}</h1>
                <p className="text-muted-foreground text-sm">{t`Review what needs you: the description, commits, files, diff and checks of each change, and your own review of it.`}</p>
            </header>
            {connected ? (
                <div className="flex flex-col gap-6 lg:flex-row">
                    <section aria-label={t`Inbox`} className="lg:w-96 lg:shrink-0">
                        <InboxList
                            host={info}
                            onSectionChange={(next) => onSearchChange({ ...search, section: next })}
                            onSelect={(repo, number) => onSearchChange({ number, repository: repo, section })}
                            section={section}
                            selected={selected}
                        />
                        {isHostCapabilityAvailable(info.capabilities, "freshness.conditionalPolling") && (
                            <div className="mt-6">
                                <WatchedRepositories
                                    onSelect={(repo, number) => onSearchChange({ number, repository: repo, section })}
                                    webhooks={isHostCapabilityAvailable(info.capabilities, "freshness.webhooks")}
                                />
                            </div>
                        )}
                    </section>
                    <section aria-label={t`Selected ${requestNoun}`} className="min-w-0 flex-1">
                        {selected ? (
                            <PullRequestView
                                host={info}
                                key={`${selected.repository}#${selected.number}`}
                                number={selected.number}
                                onTabChange={(tab: DevelopTab) => onSearchChange({ ...search, tab })}
                                repository={selected.repository}
                                tab={search.tab}
                            />
                        ) : (
                            <p className="text-muted-foreground text-sm">{t`Pick one from the inbox to read it.`}</p>
                        )}
                    </section>
                </div>
            ) : (
                <ConnectHostCard label={host.label} />
            )}
        </div>
    );
};

export default DevelopPage;
