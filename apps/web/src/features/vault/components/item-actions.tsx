"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { useMutation } from "@tanstack/react-query";
import { Download, Trash2 } from "lucide-react";
import { useState } from "react";

import DeleteConfirmationDialog from "@/components/delete-confirmation-dialog";
import { useAction, useCRPC } from "@/lib/lunora/crpc";

import { showError, showSuccess } from "../../../lib/toast";

type Properties = {
    fileName: string;
    fileType: string;
    id: string;
};

const clickAnchor = (href: string, fileName: string): void => {
    const anchor = document.createElement("a");

    anchor.href = href;
    anchor.download = fileName;
    anchor.rel = "noopener";
    anchor.target = "_blank";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
};

/**
 * Saves `url` under `fileName`. The `download` attribute is ignored for a
 * cross-origin href, so the file is fetched into a blob first; when the bucket
 * does not answer CORS for this origin, the signed URL is opened directly and
 * the browser decides between showing and saving it.
 */
const saveFromUrl = async (url: string, fileName: string): Promise<void> => {
    let blobUrl: string | undefined;

    try {
        const response = await fetch(url);

        if (!response.ok) {
            await response.body?.cancel();

            throw new Error(`HTTP ${response.status}`);
        }

        blobUrl = URL.createObjectURL(await response.blob());
    } catch {
        clickAnchor(url, fileName);

        return;
    }

    clickAnchor(blobUrl, fileName);
    // Revoked on the next task: the click has already handed the blob to the download.
    setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
};

const ItemActions = ({ fileName, fileType: _fileType, id }: Properties) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const [showDeleteDialog, setShowDeleteDialog] = useState(false);
    const [isDeleting, setIsDeleting] = useState(false);
    const [isDownloading, setIsDownloading] = useState(false);

    // Mutations
    const deleteFileMutation = useMutation(crpc.vault.functions.deleteAttachments.mutationOptions());
    const getDownloadUrl = useAction(api.vault.functions.getDownloadUrl);

    const handleDownload = async () => {
        setIsDownloading(true);

        try {
            const { url } = await getDownloadUrl({ attachmentId: id as Id<"files"> });

            await saveFromUrl(url, fileName);
        } catch (error) {
            console.error("Download error:", error);
            showError(t`Failed to download file. Please try again.`);
        } finally {
            setIsDownloading(false);
        }
    };

    const handleDelete = async () => {
        setIsDeleting(true);

        try {
            await deleteFileMutation.mutateAsync({ attachmentIds: [id] });
            showSuccess(t`File "${fileName}" deleted successfully`);
            setShowDeleteDialog(false);
        } catch (error) {
            console.error("Delete error:", error);
            showError(t`Failed to delete file. Please try again.`);
        } finally {
            setIsDeleting(false);
        }
    };

    return (
        <div className="flex flex-row gap-2">
            <Button
                aria-label={t`Download ${fileName}`}
                className="bg-background size-7 rounded-full"
                disabled={isDownloading}
                onClick={handleDownload}
                size="icon"
                variant="outline"
            >
                <Download aria-hidden="true" className="size-3.5" />
            </Button>

            <Button
                aria-label={t`Delete ${fileName}`}
                className="bg-background size-7 rounded-full"
                onClick={() => setShowDeleteDialog(true)}
                size="icon"
                variant="outline"
            >
                <Trash2 aria-hidden="true" className="size-3.5" />
            </Button>

            <DeleteConfirmationDialog
                description={t`You are about to delete "${fileName}" from your vault. This action cannot be undone.`}
                isDeleting={isDeleting}
                itemName={fileName}
                onConfirm={handleDelete}
                onOpenChange={setShowDeleteDialog}
                open={showDeleteDialog}
                title={t`Delete File`}
            />
        </div>
    );
};

export default ItemActions;
