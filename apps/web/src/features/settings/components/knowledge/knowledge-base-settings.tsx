"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
    AlertDialogTrigger,
} from "@neore/ui/components/alert-dialog";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { CardContent } from "@neore/ui/components/card";
import { skipToken, useMutation, useQuery } from "@tanstack/react-query";
import { BookOpenIcon, FileTextIcon, GlobeIcon, Loader2Icon, Trash2Icon, UploadIcon } from "lucide-react";
import type { FC } from "react";
import { lazy, Suspense, useCallback, useMemo, useState } from "react";
import { useDropzone } from "react-dropzone";
import { toast } from "sonner";

import SettingsCard from "@/components/settings/settings-card";
import { useAuth } from "@/features/auth/lib/auth-ui-provider";
import type { CollectionScope, CollectionView } from "@/features/knowledge/components/collection-picker";
import { CollectionPicker, MoveToCollection } from "@/features/knowledge/components/collection-picker";
import KnowledgeImportActions from "@/features/knowledge/components/knowledge-import-actions";
import { MAX_DOCUMENT_BYTES } from "@/features/knowledge/lib/documents";
import { knowledgeErrorKind } from "@/features/knowledge/lib/import-batch-error";
import { useCRPC, useLunoraActionOptions } from "@/lib/lunora/crpc";
import { uploadFile } from "@/lib/upload/upload-file";

// Opened on demand only.
const CollectionDialog = lazy(() => import("@/features/knowledge/components/collection-dialog"));

type KnowledgeFile = Doc<"knowledgeFiles">;

const STATUS_COLORS: Record<string, string> = {
    failed: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
    indexed: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    pending: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200",
    processing: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
};

const ACCEPTED_FILE_TYPES: Record<string, string[]> = {
    "application/json": [".json"],
    "application/msword": [".doc"],
    "application/pdf": [".pdf"],
    "application/vnd.ms-excel": [".xls"],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
    "text/csv": [".csv"],
    "text/markdown": [".md"],
    "text/plain": [".txt"],
};

const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;

    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** What a row shows: the stored fields both an own file and a shared collection's file carry. */
type FileRow = Partial<Pick<KnowledgeFile, "collectionId" | "error" | "summary">> &
    Pick<KnowledgeFile, "_id" | "chunkCount" | "mimeType" | "name" | "relativePath" | "size" | "sourceUrl" | "status">;

const KnowledgeBaseSettings: FC = () => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const { hooks } = useAuth();
    // Sharing a collection goes to the ACTIVE organization, the one the server proves.
    const { data: activeOrganization } = hooks.useActiveOrganization();
    const organizationName = activeOrganization?.name;
    const [isUploading, setIsUploading] = useState(false);
    const [isRemovingAll, setIsRemovingAll] = useState(false);
    const [scope, setScope] = useState<CollectionScope>("all");
    const [dialog, setDialog] = useState<"create" | "edit" | null>(null);

    const { data: files, refetch: refetchFiles } = useQuery(crpc.knowledge.functions.listFiles.queryOptions({}));
    const { data: collections = [], refetch: refetchCollections } = useQuery(crpc.knowledge.collections.listCollections.queryOptions({}));
    const selected: CollectionView | undefined = useMemo(() => collections.find((collection) => collection._id === scope), [collections, scope]);
    const ownSelected = selected?.isOwner ? selected._id : undefined;

    // A collection someone shared lives on its owner's shard: read through the action.
    const { mutateAsync: listCollectionFiles } = useMutation(useLunoraActionOptions(api.knowledge.collections.listCollectionFiles));
    const { data: sharedFiles } = useQuery({
        enabled: Boolean(selected && !selected.isOwner),
        queryFn: selected && !selected.isOwner ? async () => await listCollectionFiles({ collectionId: selected._id }) : skipToken,
        queryKey: ["knowledge", "shared-collection-files", selected?._id],
    });

    const { isPending: isRemoving, mutateAsync: removeFile } = useMutation({
        ...crpc.knowledge.functions.removeFile.mutationOptions(),
        onError: () => {
            toast.error(t`Failed to remove file`);
        },
        onSuccess: () => {
            refetchFiles();
            toast.success(t`File removed from knowledge base`);
        },
    });
    const { mutateAsync: setFileCollection } = useMutation(crpc.knowledge.collections.setFileCollection.mutationOptions());
    const { isPending: isSavingCollection, mutateAsync: createCollection } = useMutation(crpc.knowledge.collections.createCollection.mutationOptions());
    const { mutateAsync: updateCollection } = useMutation(crpc.knowledge.collections.updateCollection.mutationOptions());
    const { mutateAsync: deleteCollection } = useMutation(crpc.knowledge.collections.deleteCollection.mutationOptions());

    const { mutateAsync: saveVaultFile } = useMutation(useLunoraActionOptions(api.vault.functions.saveVaultFile));
    const { mutateAsync: addKnowledgeFile } = useMutation({
        ...crpc.knowledge.functions.addFile.mutationOptions(),
        onSuccess: () => {
            refetchFiles();
        },
    });

    const refreshAll = useCallback(() => {
        void refetchFiles();
        void refetchCollections();
    }, [refetchCollections, refetchFiles]);

    const uploadSingleFile = useCallback(
        async (file: File) => {
            // 1. Send the bytes to the upload route
            const uploadId = await uploadFile(file, { contentType: file.type });

            // 2. Take the upload into the vault; its real type and size come back
            const vaultFile = await saveVaultFile({ fileName: file.name, uploadId });

            // 3. Add to knowledge base (triggers ingestion), into the selected collection
            await addKnowledgeFile({
                collectionId: ownSelected,
                mimeType: vaultFile.fileType,
                name: file.name,
                size: vaultFile.fileSize,
                vaultFileId: vaultFile.fileId,
            });

            return file.name;
        },
        [saveVaultFile, addKnowledgeFile, ownSelected],
    );

    // The quota and the rate limit in the user's language; the server's own message is English.
    const uploadErrorText = useCallback(
        (kind: ReturnType<typeof knowledgeErrorKind>): string => {
            if (kind === "quota") {
                return t`Your knowledge base is full. Remove files to add more.`;
            }

            return kind === "rate-limited"
                ? t`You are adding documents too quickly. Wait a moment and try again.`
                : t`Failed to upload file. Please try again.`;
        },
        [t],
    );

    const onDrop = useCallback(
        async (acceptedFiles: File[]) => {
            if (acceptedFiles.length === 0) {
                return;
            }

            setIsUploading(true);

            try {
                const results = await Promise.allSettled(acceptedFiles.map((file) => uploadSingleFile(file)));

                for (const result of results) {
                    if (result.status === "fulfilled") {
                        toast.success(t`Added "${result.value}" to knowledge base`);
                    } else {
                        console.error("Knowledge base upload error:", result.reason);
                        toast.error(uploadErrorText(knowledgeErrorKind(result.reason)));
                    }
                }
            } finally {
                setIsUploading(false);
            }
        },
        [t, uploadSingleFile, uploadErrorText],
    );

    const visibleFiles: FileRow[] | undefined = useMemo(() => {
        if (selected && !selected.isOwner) {
            return sharedFiles;
        }

        if (!files) {
            return undefined;
        }

        if (scope === "all") {
            return files;
        }

        return files.filter((file: KnowledgeFile) => (scope === "none" ? !file.collectionId : file.collectionId === scope));
    }, [files, scope, selected, sharedFiles]);

    const handleRemoveAll = useCallback(async () => {
        if (!visibleFiles || visibleFiles.length === 0) {
            return;
        }

        setIsRemovingAll(true);

        try {
            const results = await Promise.allSettled(visibleFiles.map((file) => removeFile({ fileId: file._id })));

            const failed = results.filter((r) => r.status === "rejected").length;

            if (failed > 0) {
                toast.error(t`Failed to remove ${failed} file(s)`);
            } else {
                toast.success(t`All files removed from knowledge base`);
            }
        } finally {
            setIsRemovingAll(false);
            refetchFiles();
        }
    }, [visibleFiles, removeFile, refetchFiles, t]);

    const handleMove = useCallback(
        async (fileId: Id<"knowledgeFiles">, collectionId: Id<"knowledgeCollections"> | undefined) => {
            try {
                await setFileCollection({ collectionId, fileIds: [fileId] });
                refetchFiles();
            } catch {
                toast.error(t`Failed to move file`);
            }
        },
        [refetchFiles, setFileCollection, t],
    );

    const handleDeleteCollection = useCallback(
        async (deleteFiles: boolean) => {
            if (!ownSelected) {
                return;
            }

            try {
                await deleteCollection({ collectionId: ownSelected, deleteFiles });
                setScope("all");
                refreshAll();
                toast.success(deleteFiles ? t`Collection and its files deleted` : t`Collection deleted; its files are now uncategorised`);
            } catch (error) {
                toast.error(error instanceof Error && error.message ? error.message : t`Failed to delete collection`);
            }
        },
        [deleteCollection, ownSelected, refreshAll, t],
    );

    const { getInputProps, getRootProps, isDragActive } = useDropzone({
        accept: ACCEPTED_FILE_TYPES,
        disabled: isUploading || Boolean(selected && !selected.isOwner),
        maxFiles: 10,
        // The vault cap the upload is saved under (`backend/lunora/vault/lib/file-constants.ts`).
        maxSize: MAX_DOCUMENT_BYTES,
        multiple: true,
        onDrop,
        onDropRejected: (fileRejections) => {
            const rejection = fileRejections[0];

            if (rejection?.errors.find(({ code }) => code === "file-too-large")) {
                toast.error(t`File size too large. Maximum 5MB allowed.`);
            } else if (rejection?.errors.find(({ code }) => code === "file-invalid-type")) {
                toast.error(t`File type not supported. Supported: PDF, DOCX, TXT, MD, CSV, JSON, XLS, XLSX.`);
            } else {
                toast.error(t`File upload rejected.`);
            }
        },
    });

    const totalCount = visibleFiles?.length ?? 0;
    const indexedCount = visibleFiles?.filter((file) => file.status === "indexed").length ?? 0;
    const isBusy = isRemoving || isRemovingAll;
    const readOnly = Boolean(selected && !selected.isOwner);
    const ownCollections = collections.filter((collection) => collection.isOwner);

    return (
        <SettingsCard
            description={t`Upload documents to your knowledge base and group them into collections. The AI searches them for relevant context and cites the passages it used.`}
            title={t`Knowledge Base`}
        >
            <CardContent className="space-y-4">
                <CollectionPicker
                    collections={collections}
                    counts={files}
                    onCreate={() => setDialog("create")}
                    onDelete={handleDeleteCollection}
                    onEdit={() => setDialog("edit")}
                    onScopeChange={setScope}
                    scope={scope}
                />

                {readOnly ? (
                    <p className="text-muted-foreground bg-muted/50 rounded-md p-3 text-xs">{t`This collection is shared with you by a member of your organization. You can attach it to chats and projects; only its owner can change its files.`}</p>
                ) : (
                    <>
                        {/* Upload zone */}
                        <div
                            {...getRootProps()}
                            className={`cursor-pointer rounded-lg border-2 border-dashed p-6 text-center transition-colors ${
                                isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-muted-foreground/50"
                            } ${isUploading ? "pointer-events-none opacity-50" : ""}`}
                        >
                            <input {...getInputProps()} />
                            {isUploading ? (
                                <div className="flex flex-col items-center gap-2">
                                    <Loader2Icon aria-hidden="true" className="text-muted-foreground h-8 w-8 animate-spin" />
                                    <p className="text-muted-foreground text-sm">{t`Uploading...`}</p>
                                </div>
                            ) : (
                                <div className="flex flex-col items-center gap-2">
                                    <UploadIcon aria-hidden="true" className="text-muted-foreground h-8 w-8" />
                                    <p className="text-sm">{isDragActive ? t`Drop files here...` : t`Drag & drop files here, or click to browse`}</p>
                                    <p className="text-muted-foreground text-xs">{t`PDF, DOCX, TXT, MD, CSV, JSON, XLS, XLSX — max 5MB`}</p>
                                </div>
                            )}
                        </div>

                        <KnowledgeImportActions collectionId={ownSelected} onChange={refreshAll} />
                    </>
                )}

                {/* Stats */}
                {totalCount > 0 && (
                    <div className="flex items-center gap-2">
                        <BookOpenIcon aria-hidden="true" className="text-muted-foreground h-4 w-4" />
                        <span className="text-muted-foreground text-xs">{t`${indexedCount} of ${totalCount} files indexed`}</span>
                    </div>
                )}

                {/* File list */}
                {visibleFiles && visibleFiles.length > 0 ? (
                    <ul className="max-h-80 space-y-2 overflow-y-auto" style={{ contentVisibility: "auto" }}>
                        {visibleFiles.map((file) => (
                            <li className="bg-muted/50 group flex items-start gap-2 rounded-md p-2" key={file._id as string}>
                                {file.sourceUrl ? (
                                    <GlobeIcon aria-hidden="true" className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                                ) : (
                                    <FileTextIcon aria-hidden="true" className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
                                )}
                                <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5">
                                        <span className="truncate text-sm font-medium" title={file.sourceUrl ?? file.relativePath ?? file.name}>
                                            {file.name}
                                        </span>
                                        <Badge className={`px-1.5 py-0 text-[10px] ${STATUS_COLORS[file.status] ?? STATUS_COLORS.pending}`} variant="secondary">
                                            {file.status}
                                        </Badge>
                                    </div>
                                    <div className="text-muted-foreground mt-0.5 flex items-center gap-2 text-[10px]">
                                        {file.sourceUrl ? <span className="truncate">{file.sourceUrl}</span> : <span>{formatFileSize(file.size)}</span>}
                                        {file.relativePath && file.relativePath !== file.name && <span className="truncate">{file.relativePath}</span>}
                                        {file.chunkCount != null && <span>{t`${file.chunkCount} chunks`}</span>}
                                        {file.summary && (
                                            <span className="truncate" title={file.summary}>
                                                {file.summary}
                                            </span>
                                        )}
                                    </div>
                                    {file.error && <p className="text-destructive mt-0.5 text-[10px]">{file.error}</p>}
                                </div>
                                {!readOnly && (
                                    <>
                                        <MoveToCollection
                                            collections={ownCollections}
                                            current={file.collectionId}
                                            fileName={file.name}
                                            onMove={(collectionId) => handleMove(file._id, collectionId)}
                                        />
                                        <Button
                                            aria-label={t`Remove file`}
                                            className="h-6 w-6 shrink-0 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                                            disabled={isBusy}
                                            onClick={() => removeFile({ fileId: file._id })}
                                            size="icon"
                                            variant="ghost"
                                        >
                                            {isBusy ? (
                                                <Loader2Icon aria-hidden="true" className="h-3 w-3 animate-spin" />
                                            ) : (
                                                <Trash2Icon aria-hidden="true" className="h-3 w-3" />
                                            )}
                                        </Button>
                                    </>
                                )}
                            </li>
                        ))}
                    </ul>
                ) : (
                    !isUploading && (
                        <div className="text-muted-foreground py-2 text-center text-sm">
                            {scope === "all" ? t`No files in your knowledge base yet. Upload documents above to get started.` : t`No files here yet.`}
                        </div>
                    )
                )}

                {/* Clear all */}
                {!readOnly && visibleFiles && visibleFiles.length > 0 && (
                    <AlertDialog>
                        {/* Base UI composes via `render`, not Radix's `asChild`. */}
                        <AlertDialogTrigger render={<Button className="w-full" disabled={isBusy} variant="destructive" />}>
                            {isRemovingAll ? (
                                <Loader2Icon aria-hidden="true" className="mr-2 h-4 w-4 animate-spin" />
                            ) : (
                                <Trash2Icon aria-hidden="true" className="mr-2 h-4 w-4" />
                            )}
                            {scope === "all" ? t`Remove All Files` : t`Remove These Files`}
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                            <AlertDialogHeader>
                                <AlertDialogTitle>{t`Remove ${visibleFiles.length} knowledge base files?`}</AlertDialogTitle>
                                <AlertDialogDescription>
                                    {t`This will permanently remove these ${visibleFiles.length} files from your knowledge base, including their indexed content. The original files in your vault will not be affected.`}
                                </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                                <AlertDialogCancel>{t`Cancel`}</AlertDialogCancel>
                                <AlertDialogAction onClick={handleRemoveAll}>{t`Remove All`}</AlertDialogAction>
                            </AlertDialogFooter>
                        </AlertDialogContent>
                    </AlertDialog>
                )}
            </CardContent>

            {dialog && (
                <Suspense fallback={null}>
                    <CollectionDialog
                        initial={
                            dialog === "edit" && selected
                                ? { description: selected.description ?? "", name: selected.name, shareWithOrganization: selected.shared }
                                : undefined
                        }
                        isSaving={isSavingCollection}
                        onOpenChange={(open) => {
                            if (!open) {
                                setDialog(null);
                            }
                        }}
                        onSave={async (draft) => {
                            try {
                                if (dialog === "edit" && ownSelected) {
                                    await updateCollection({ collectionId: ownSelected, ...draft });
                                } else {
                                    setScope(await createCollection(draft));
                                }

                                setDialog(null);
                                void refetchCollections();
                            } catch (error) {
                                toast.error(error instanceof Error && error.message ? error.message : t`Failed to save collection`);
                            }
                        }}
                        open
                        organizationName={organizationName}
                    />
                </Suspense>
            )}
        </SettingsCard>
    );
};

export default KnowledgeBaseSettings;
