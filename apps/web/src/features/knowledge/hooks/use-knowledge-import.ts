"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import type { DocumentCandidate, EncodedDocument } from "@/features/knowledge/lib/documents";
import { encodeDocument, MAX_DOCUMENTS_PER_IMPORT, toBatches } from "@/features/knowledge/lib/documents";
import { classifyImportBatchError, knowledgeErrorKind } from "@/features/knowledge/lib/import-batch-error";
import { listArchiveEntries, notionDocuments } from "@/features/knowledge/lib/notion-export";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { loadJsZip } from "@/lib/zip";

const ZIP_EXTENSION_RE = /\.zip$/i;
const NOTION_EXPORT_PREFIX_RE = /^Export-[\da-f-]+/i;

export type CollectionId = Id<"knowledgeCollections">;

/** How often one rate-limited batch is sent again before it counts as failed. */
const MAX_BATCH_RETRIES = 3;

const wait = async (ms: number): Promise<void> => {
    await new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });
};

/**
 * The toast for a failed single write: the quota and the rate limit in the
 * user's language, any other server message as it came, else `fallback`.
 */
const knowledgeWriteErrorText = (error: unknown, texts: { fallback: string; quota: string; rateLimited: string }): string => {
    const kind = knowledgeErrorKind(error);

    if (kind === "quota") {
        return texts.quota;
    }

    if (kind === "rate-limited") {
        return texts.rateLimited;
    }

    return error instanceof Error && error.message ? error.message : texts.fallback;
};

/**
 * Sends one batch, waiting out the per-document rate limit (`retryAfter`) a
 * few times. Outside the hook: a branch inside a `catch` makes the React
 * Compiler skip the component that holds it.
 */
const sendBatch = async <T>(send: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; quota: boolean }> => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return { ok: true, value: await send() };
        } catch (error) {
            const outcome = classifyImportBatchError(error);

            if (outcome.kind === "retry" && attempt < MAX_BATCH_RETRIES) {
                await wait(outcome.afterMs);
            } else {
                console.error("Knowledge import batch failed:", error);

                return { ok: false, quota: outcome.kind === "quota" };
            }
        }
    }
};

export interface ImportProgress {
    done: number;
    total: number;
}

/**
 * The three ways into the knowledge base that are not a single upload: a
 * folder, a Notion export and a URL. Documents are encoded lazily and sent in
 * batches (`toBatches`), so a large folder never sits in memory as one string.
 */
const useKnowledgeImport = (onChange: () => void) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const [progress, setProgress] = useState<ImportProgress | null>(null);
    // From the moment an import starts — reading a ZIP and creating its collection come before any progress.
    const [isImporting, setIsImporting] = useState(false);
    const { mutateAsync: addDocuments } = useMutation(useLunoraActionOptions(api.knowledge.documents.addDocuments));
    const { mutateAsync: addUrlMutation, isPending: isAddingUrl } = useMutation(crpc.knowledge.documents.addUrl.mutationOptions());
    const { mutateAsync: createCollection } = useMutation(crpc.knowledge.collections.createCollection.mutationOptions());

    /** Sends the candidates in batches; returns how many were added. A failed batch is reported and the rest continue. */
    const sendDocuments = useCallback(
        async (candidates: ReadonlyArray<DocumentCandidate>, collectionId: CollectionId | undefined): Promise<number> => {
            const limited = candidates.slice(0, MAX_DOCUMENTS_PER_IMPORT);
            let added = 0;
            let failed = 0;
            let quotaReached = false;

            setProgress({ done: 0, total: limited.length });

            try {
                // Encode in slices of one batch at most, so memory holds one batch at a time.
                for (let start = 0; start < limited.length; start += 25) {
                    // A file that cannot be read counts as failed; the rest still go.
                    const slice = await Promise.all(
                        limited.slice(start, start + 25).map(async (candidate) => {
                            try {
                                return await encodeDocument(candidate);
                            } catch (error) {
                                console.error("Knowledge import could not read a document:", error);

                                return null;
                            }
                        }),
                    );
                    const encoded: EncodedDocument[] = slice.filter((document): document is EncodedDocument => document !== null);

                    failed += slice.length - encoded.length;

                    for (const batch of toBatches(encoded)) {
                        const result = await sendBatch(async () => await addDocuments({ collectionId, documents: batch }));

                        if (result.ok) {
                            added += result.value.length;
                        } else {
                            failed += batch.length;
                            quotaReached = result.quota;
                        }

                        setProgress({ done: added + failed, total: limited.length });

                        if (quotaReached) {
                            break;
                        }
                    }

                    // The quota is full: every later batch would fail the same way.
                    if (quotaReached) {
                        failed = limited.length - added;
                        break;
                    }
                }
            } finally {
                setProgress(null);
                onChange();
            }

            if (quotaReached) {
                toast.error(t`Your knowledge base is full. ${failed} document(s) were not added.`);
            } else if (failed > 0) {
                toast.error(t`${failed} document(s) could not be added.`);
            }

            if (candidates.length > limited.length) {
                toast.warning(t`Only the first ${MAX_DOCUMENTS_PER_IMPORT} documents were imported.`);
            }

            return added;
        },
        [addDocuments, onChange, t],
    );

    const importFolder = useCallback(
        async (candidates: ReadonlyArray<DocumentCandidate>, skippedCount: number, collectionId: CollectionId | undefined) => {
            if (candidates.length === 0) {
                toast.error(t`The folder has no supported documents.`);

                return;
            }

            setIsImporting(true);

            try {
                const added = await sendDocuments(candidates, collectionId);

                if (added > 0) {
                    toast.success(
                        skippedCount > 0
                            ? t`Added ${added} document(s); skipped ${skippedCount} unsupported or oversized file(s).`
                            : t`Added ${added} document(s).`,
                    );
                }
            } finally {
                setIsImporting(false);
            }
        },
        [sendDocuments, t],
    );

    /**
     * Imports a Notion export. With no collection chosen, the pages go into a
     * new collection named after the archive, so they stay together.
     */
    const importNotionExport = useCallback(
        async (file: File, collectionId: CollectionId | undefined) => {
            setIsImporting(true);

            try {
                let documents: DocumentCandidate[];
                let skipped: number;

                try {
                    ({ documents, skipped } = notionDocuments(await listArchiveEntries(await file.arrayBuffer(), loadJsZip)));
                } catch (error) {
                    console.error("Notion export could not be read:", error);
                    toast.error(t`This file is not a readable ZIP archive.`);

                    return;
                }

                if (documents.length === 0) {
                    toast.error(t`No pages found. Export from Notion as "Markdown & CSV" or "HTML".`);

                    return;
                }

                let target = collectionId;

                if (target === undefined) {
                    const defaultName = t`Notion export`;

                    try {
                        target = await createCollection({
                            name:
                                file.name
                                    .replace(ZIP_EXTENSION_RE, "")
                                    .replace(NOTION_EXPORT_PREFIX_RE, () => defaultName)
                                    .slice(0, 80) || defaultName,
                        });
                    } catch (error) {
                        console.error("Notion export collection could not be created:", error);
                        toast.error(t`Could not create a collection for this import. Try again.`);

                        return;
                    }
                }

                const added = await sendDocuments(documents, target);

                if (added > 0) {
                    toast.success(skipped > 0 ? t`Imported ${added} Notion page(s); skipped ${skipped} attachment(s).` : t`Imported ${added} Notion page(s).`);
                }
            } finally {
                setIsImporting(false);
            }
        },
        [createCollection, sendDocuments, t],
    );

    const addUrl = useCallback(
        async (url: string, collectionId: CollectionId | undefined): Promise<boolean> => {
            try {
                await addUrlMutation({ collectionId, url });
                toast.success(t`Page added. It is being fetched and indexed.`);
                onChange();

                return true;
            } catch (error) {
                toast.error(
                    knowledgeWriteErrorText(error, {
                        fallback: t`This URL cannot be added.`,
                        quota: t`Your knowledge base is full. Remove files to add more.`,
                        rateLimited: t`You are adding documents too quickly. Wait a moment and try again.`,
                    }),
                );

                return false;
            }
        },
        [addUrlMutation, onChange, t],
    );

    return { addUrl, importFolder, importNotionExport, isAddingUrl, isImporting: isImporting || progress !== null, progress };
};

export default useKnowledgeImport;
