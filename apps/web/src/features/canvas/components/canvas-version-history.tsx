"use client";

/**
 * Canvas Version History — Side-by-side version list + diff viewer.
 *
 * Left panel: chronological version list from documentVersions table.
 * Right panel: inline diff rendered by CanvasTextDiffViewer or CanvasCodeDiffViewer.
 * Includes a "Restore" button to roll back to a selected version.
 */

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import cn from "@neore/ui/utils/cn";
import formatTimeAgo from "@neore/ui/utils/relative-time";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { JSONContent } from "@tiptap/core";
import { getSchema } from "@tiptap/core";
import { ArrowLeftIcon, RotateCcwIcon } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import { useCanvasState } from "@/features/chat/core/stores/chat-ui-store";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

import type { DiffCommit } from "../lib/diff-commit";
import computeCommit from "../lib/diff-commit";
import { getCanvasExtensions } from "../lib/tiptap-extensions";
import CanvasCodeDiffViewer from "./canvas-code-diff-viewer";
import CanvasTextDiffViewer from "./canvas-text-diff-viewer";

interface CanvasVersionHistoryProps {
    document: {
        _id: string;
        content?: string;
        contentJson?: unknown;
        kind: string;
        language?: string;
        version: number;
    };
}

const CanvasVersionHistory: FC<CanvasVersionHistoryProps> = ({ document }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const { activeDocumentId, setCanvasViewMode } = useCanvasState();
    const [selectedVersion, setSelectedVersion] = useState<number | null>(null);

    // Fetch version list (metadata only)
    const { data: versions } = useQuery({
        ...crpc.agent.document_history.listVersions.queryOptions({
            documentId: document._id as Id<"documents">,
        }),
        enabled: !!document._id,
    });

    // Fetch selected version's full data
    const { data: selectedVersionData } = useQuery({
        ...crpc.agent.document_history.getVersion.queryOptions({
            documentId: document._id as Id<"documents">,
            version: selectedVersion ?? 0,
        }),
        enabled: selectedVersion !== null,
    });

    // Also fetch the next version (version + 1) for computing diffs when no commit stored
    const nextVersionNumber = selectedVersion === null ? null : selectedVersion + 1;
    const { data: nextVersionData } = useQuery({
        ...crpc.agent.document_history.getVersion.queryOptions({
            documentId: document._id as Id<"documents">,
            version: nextVersionNumber ?? 0,
        }),
        enabled: nextVersionNumber !== null && selectedVersionData !== undefined && selectedVersionData !== null && !selectedVersionData.commit,
    });

    const { mutateAsync: updateDocument } = useMutation(crpc.agent.documents.updateDocument.mutationOptions());

    // Create a schema for diff computation (fallback path)
    const schema = getSchema(getCanvasExtensions());

    // Build the diff commit for display
    const buildDiffCommit = (): DiffCommit | null => {
        if (!selectedVersionData || document.kind !== "text") {
            return null;
        }

        // If the version has a stored native commit, use it directly
        if (selectedVersionData.commit) {
            return selectedVersionData.commit as DiffCommit;
        }

        // Fallback: compute diff between this version and the next version
        const olderJson = selectedVersionData.contentJson as JSONContent | undefined;
        // The next version's contentJson, or current document state for the latest stored version
        const newerJson = (nextVersionData?.contentJson ?? document.contentJson) as JSONContent | undefined;

        if (!olderJson || !newerJson) {
            return null;
        }

        try {
            return computeCommit(schema, olderJson, newerJson);
        } catch {
            return null;
        }
    };

    const diffCommit = buildDiffCommit();

    // Code diff data for code documents
    const buildCodeDiff = () => {
        if (!selectedVersionData || document.kind !== "code") {
            return null;
        }

        const olderContent = selectedVersionData.content ?? "";
        // Next version content or current document content
        const newerContent = nextVersionData?.content ?? document.content ?? "";

        return { newerContent, olderContent };
    };

    const codeDiff = buildCodeDiff();

    const handleSelectVersion = (version: number) => {
        setSelectedVersion(version);
    };

    const handleRestore = async () => {
        if (!selectedVersionData || !activeDocumentId) {
            return;
        }

        try {
            await updateDocument({
                content: selectedVersionData.content,
                contentJson: selectedVersionData.contentJson,
                documentId: activeDocumentId as Id<"documents">,
            });
        } catch (error) {
            // The click handler discards this promise, so a rejection here would
            // otherwise surface only as an unhandled rejection.
            showError(error instanceof Error ? error : t`Failed to restore this version.`);

            return;
        }

        setCanvasViewMode("editor");
    };

    const handleBack = () => {
        setCanvasViewMode("editor");
    };

    let diffBody = (
        <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">{t`No diff data available for this version`}</p>
        </div>
    );

    if (document.kind === "text" && diffCommit) {
        diffBody = <CanvasTextDiffViewer commit={diffCommit} />;
    } else if (document.kind === "code" && codeDiff) {
        diffBody = <CanvasCodeDiffViewer language={document.language} modifiedContent={codeDiff.newerContent} originalContent={codeDiff.olderContent} />;
    }

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="flex items-center gap-2 border-b px-4 py-2">
                <button
                    className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm transition-colors"
                    onClick={handleBack}
                    type="button"
                >
                    <ArrowLeftIcon className="size-4" />
                    {t`Back to editor`}
                </button>
            </div>

            {/* Content */}
            <div className="flex flex-1 overflow-hidden">
                {/* Version list */}
                <div className="w-48 shrink-0 overflow-auto border-r">
                    <div className="p-2">
                        <h4 className="text-muted-foreground mb-2 px-2 text-xs font-medium uppercase">{t`Versions`}</h4>
                        {versions?.map((v) => {
                            const isSelected = selectedVersion === v.version;

                            return (
                                <button
                                    className={cn(
                                        "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                                        "hover:bg-muted",
                                        isSelected && "bg-muted text-foreground",
                                        !isSelected && "text-muted-foreground",
                                    )}
                                    key={v.version}
                                    onClick={() => handleSelectVersion(v.version)}
                                    type="button"
                                >
                                    <div className="flex items-center gap-2">
                                        <span
                                            className={cn(
                                                "flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium",
                                                v.version === (versions[0]?.version ?? 0) ? "bg-primary text-primary-foreground" : "bg-muted-foreground/20",
                                            )}
                                        >
                                            {v.version}
                                        </span>
                                        <span className="truncate text-xs">{formatTimeAgo(v.createdAt, i18n.locale)}</span>
                                    </div>
                                    <span className="truncate pl-7 text-xs opacity-60">{v.userId}</span>
                                </button>
                            );
                        })}
                        {!versions?.length && <p className="text-muted-foreground px-2 text-xs">{t`No history yet`}</p>}
                    </div>
                </div>

                {/* Diff view */}
                <div className="flex flex-1 flex-col overflow-hidden">
                    {selectedVersion !== null && selectedVersionData ? (
                        <>
                            <div className="flex-1 overflow-auto">{diffBody}</div>

                            {/* Restore button */}
                            <div className="border-t p-3">
                                <button
                                    className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex w-full items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors"
                                    onClick={handleRestore}
                                    type="button"
                                >
                                    <RotateCcwIcon className="size-4" />
                                    {t`Restore version ${selectedVersion}`}
                                </button>
                            </div>
                        </>
                    ) : (
                        <div className="flex h-full items-center justify-center">
                            <p className="text-muted-foreground text-sm">{t`Select a version to see changes`}</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

export default CanvasVersionHistory;
