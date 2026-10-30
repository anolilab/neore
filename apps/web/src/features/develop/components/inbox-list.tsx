"use client";

import { useLingui } from "@lingui/react/macro";
import type { HostCapabilityKey } from "@neore/backend/source-control/capabilities";
import { hostCapabilityOf, isHostCapabilityAvailable } from "@neore/backend/source-control/capabilities";
import type { InboxSection } from "@neore/backend/source-control/types";
import { INBOX_SECTIONS } from "@neore/backend/source-control/types";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { Skeleton } from "@neore/ui/components/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@neore/ui/components/tabs";
import cn from "@neore/ui/utils/cn";

import { useInbox } from "../lib/use-develop";
import FailureNotice from "./failure-notice";
import type { HostInfo } from "./host-info";

const SECTION_CAPABILITY: Record<InboxSection, HostCapabilityKey> = {
    drafts: "inbox.drafts",
    mine: "inbox.mine",
    needsMyReview: "inbox.needsMyReview",
    readyToMerge: "inbox.readyToMerge",
};

/** The sections this host can list, in display order. */
export const availableSections = (host: Pick<HostInfo, "capabilities">): InboxSection[] =>
    INBOX_SECTIONS.filter((section) => isHostCapabilityAvailable(host.capabilities, SECTION_CAPABILITY[section]));

const InboxList = ({
    host,
    onSectionChange,
    onSelect,
    section,
    selected,
}: {
    host: HostInfo;
    onSectionChange: (section: InboxSection) => void;
    onSelect: (repo: string, number: number) => void;
    section: InboxSection | undefined;
    selected: { number: number; repository: string } | undefined;
}) => {
    const { t } = useLingui();
    const inbox = useInbox(section);

    if (section === undefined) {
        return <p className="text-muted-foreground text-sm">{t`This host does not offer an inbox yet.`}</p>;
    }

    const sections = availableSections(host);
    const labels: Record<InboxSection, string> = {
        drafts: t`Drafts`,
        mine: t`Mine`,
        needsMyReview: t`Needs my review`,
        readyToMerge: t`Ready to merge`,
    };
    const capability = hostCapabilityOf(host.capabilities, SECTION_CAPABILITY[section]);
    // A section the host only approximates says how, in the driver's own words.
    const note = capability.supported && capability.degradation !== "none" ? capability.note : undefined;
    const pages = inbox.data?.pages ?? [];
    const failure = pages.find((page) => page.status !== "ok");
    const items = pages.flatMap((page) => (page.status === "ok" ? page.items : []));

    return (
        <div className="space-y-3">
            <Tabs onValueChange={(value) => onSectionChange(value as InboxSection)} value={section}>
                <TabsList className="flex-wrap">
                    {sections.map((candidate) => (
                        <TabsTrigger key={candidate} value={candidate}>
                            {labels[candidate]}
                        </TabsTrigger>
                    ))}
                </TabsList>
            </Tabs>
            {note && <p className="text-muted-foreground text-xs">{note}</p>}
            {inbox.isPending && (
                <div aria-label={t`Loading`} className="space-y-2" role="status">
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                    <Skeleton className="h-14 w-full" />
                </div>
            )}
            {inbox.isError && <FailureNotice label={host.label} status="host_error" />}
            {failure && <FailureNotice label={host.label} status={failure.status} />}
            {!failure && inbox.data && items.length === 0 && <p className="text-muted-foreground text-sm">{t`Nothing here.`}</p>}
            {items.length > 0 && (
                <ul className="divide-y rounded-md border">
                    {items.map((item) => {
                        const isCurrent = selected?.repository === item.repository && selected?.number === item.number;

                        return (
                            <li key={`${item.repository}#${item.number}`}>
                                <button
                                    aria-current={isCurrent ? "true" : undefined}
                                    className={cn(
                                        "hover:bg-muted focus-visible:ring-ring w-full space-y-1 px-3 py-2 text-left outline-none focus-visible:ring-2",
                                        isCurrent && "bg-muted",
                                    )}
                                    onClick={() => onSelect(item.repository, item.number)}
                                    type="button"
                                >
                                    <span className="block truncate text-sm font-medium">{item.title}</span>
                                    <span className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                                        <span>
                                            {item.repository}#{item.number}
                                        </span>
                                        <span>{item.authorLogin}</span>
                                        <time dateTime={new Date(item.updatedAt).toISOString()}>{new Date(item.updatedAt).toLocaleDateString()}</time>
                                        {item.draft && <Badge variant="secondary">{t`Draft`}</Badge>}
                                    </span>
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}
            {inbox.hasNextPage && (
                <Button disabled={inbox.isFetchingNextPage} onClick={() => inbox.fetchNextPage()} variant="outline">
                    {t`Load more`}
                </Button>
            )}
        </div>
    );
};

export default InboxList;
