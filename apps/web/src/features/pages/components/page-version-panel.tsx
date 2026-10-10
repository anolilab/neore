"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import cn from "@neore/ui/utils/cn";
import { skipToken, useQuery } from "@tanstack/react-query";
import type { JSONContent } from "@tiptap/core";
import type { FC } from "react";
import { lazy, Suspense, useState } from "react";

import { useCRPC } from "@/lib/lunora/crpc";
import { showSuccess } from "@/lib/toast";

import { stripCommentMarks } from "../lib/comment-mark";
import { dayKind, groupVersionsByDay } from "../lib/version-groups";

// The canvas AI diff viewer, reused — lazy, it mounts two TipTap editors.
const CanvasTextDiffViewer = lazy(() => import("@/features/canvas/components/canvas-text-diff-viewer"));

const EMPTY_DOC: JSONContent = { content: [], type: "doc" };

interface PageVersionPanelProps {
    canRestore: boolean;
    currentJson: () => JSONContent | undefined;
    /** Restores through the page's revision check; resolves `false` when it did not happen. */
    onRestore: (versionId: string) => Promise<boolean>;
    pageId: string;
}

/**
 * The page's version history: one entry per author per 10-minute window
 * (grouped server-side), headed by day. Selecting one shows it against the
 * current page in the canvas diff viewer; "Restore" writes it back as a new
 * version, so a restore can itself be undone.
 */
const PageVersionPanel: FC<PageVersionPanelProps> = ({ canRestore, currentJson, onRestore, pageId }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    // "Today" is judged against when the panel opened, not re-read on every render.
    const [now] = useState(() => Date.now());
    const { data: versions } = useQuery(crpc.pages.functions.listPageVersions.queryOptions({ pageId: pageId as never }));
    const { data: selected } = useQuery(crpc.pages.functions.getPageVersion.queryOptions(selectedId ? { versionId: selectedId as never } : skipToken));
    const [restoring, setRestoring] = useState(false);

    const groups = groupVersionsByDay(versions ?? []);
    const timeFormat = new Intl.DateTimeFormat(i18n.locale, { timeStyle: "short" });
    const dayFormat = new Intl.DateTimeFormat(i18n.locale, { dateStyle: "medium" });
    const reasonLabel = { agent: t`AI edit`, edit: t`Edit`, restore: t`Restored` } as const;

    const dayLabel = (day: number): string => {
        const kind = dayKind(day, now);

        if (kind === "today") {
            return t`Today`;
        }

        return kind === "yesterday" ? t`Yesterday` : dayFormat.format(day);
    };

    const handleRestore = () => {
        if (!selectedId) {
            return;
        }

        setRestoring(true);
        void (async () => {
            try {
                if (await onRestore(selectedId)) {
                    showSuccess(t`Version restored`);
                    setSelectedId(null);
                }
            } finally {
                setRestoring(false);
            }
        })();
    };

    return (
        <section aria-label={t`Version history`} className="flex h-full flex-col">
            <div className="border-b px-3 py-2">
                <h2 className="text-sm font-semibold">{t`Version history`}</h2>
            </div>
            {selected ? (
                <div className="flex min-h-0 flex-1 flex-col">
                    <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                        <Button onClick={() => setSelectedId(null)} size="sm" variant="ghost">
                            {t`Back`}
                        </Button>
                        {canRestore && (
                            <Button aria-busy={restoring} disabled={restoring} onClick={handleRestore} size="sm">
                                {t`Restore this version`}
                            </Button>
                        )}
                    </div>
                    <p className="text-muted-foreground px-3 py-1 text-xs">{t`Left: this version. Right: the page now.`}</p>
                    <Suspense
                        fallback={
                            <p className="text-muted-foreground p-3 text-xs" role="status">
                                {t`Loading comparison…`}
                            </p>
                        }
                    >
                        <CanvasTextDiffViewer
                            className="min-h-0 flex-1"
                            commit={{
                                doc: stripCommentMarks(currentJson() ?? EMPTY_DOC),
                                parent: stripCommentMarks((selected.contentJson as JSONContent | undefined) ?? EMPTY_DOC),
                                steps: [],
                            }}
                        />
                    </Suspense>
                </div>
            ) : (
                <div className="min-h-0 flex-1 overflow-y-auto p-2">
                    {versions !== undefined && versions.length === 0 && (
                        <p className="text-muted-foreground p-4 text-center text-xs">{t`No versions yet. Versions are saved as you edit.`}</p>
                    )}
                    {groups.map((group) => (
                        <div className="mb-3" key={group.day}>
                            <h3 className="text-muted-foreground px-2 pb-1 text-xs font-medium">{dayLabel(group.day)}</h3>
                            <ul>
                                {group.versions.map((version) => (
                                    <li key={version._id}>
                                        <button
                                            className={cn(
                                                "hover:bg-muted flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm",
                                            )}
                                            onClick={() => setSelectedId(version._id)}
                                            type="button"
                                        >
                                            <span>
                                                <time dateTime={new Date(version.updatedAt).toISOString()}>
                                                    {version.createdAt === version.updatedAt
                                                        ? timeFormat.format(version.updatedAt)
                                                        : `${timeFormat.format(version.createdAt)} – ${timeFormat.format(version.updatedAt)}`}
                                                </time>
                                                <span className="text-muted-foreground block text-xs">
                                                    {version.isOwnEdit ? t`by you` : t`by a collaborator`}
                                                </span>
                                            </span>
                                            <Badge variant={version.reason === "edit" ? "outline" : "secondary"}>{reasonLabel[version.reason]}</Badge>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>
            )}
        </section>
    );
};

export default PageVersionPanel;
