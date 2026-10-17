import type { MessageDescriptor } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Id } from "@neore/backend/dataModel";
import { useCallback, useState } from "react";

import { uploadChatAttachment } from "@/features/chat/core/adapters/lunora-attachment-adapter";
import { saveBlob } from "@/lib/download";
import { useLunora } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";
import { createJsZip, loadJsZip } from "@/lib/zip";

import { useWorkflowStore } from "../stores/workflow-store";
import type { WorkflowBundleErrorCode } from "../utils/workflow-bundle";
import { downloadBundleSource, exportWorkflowBundle, importWorkflowBundle, readWorkflowBundle, WorkflowBundleError } from "../utils/workflow-bundle";

/** Why a workflow file cannot be read, in words. */
const BUNDLE_ERROR_MESSAGES: Record<WorkflowBundleErrorCode, MessageDescriptor> = {
    "asset-mismatch": msg`An image in the file is corrupt.`,
    "invalid-node": msg`The workflow file contains an invalid node.`,
    "not-workflow": msg`This file is not a workflow export.`,
    "too-large": msg`The workflow file is too large.`,
    "too-many-entries": msg`The archive holds too many files.`,
    "too-many-nodes": msg`The workflow has too many nodes.`,
    "unknown-node-type": msg`The workflow file contains a node type this version does not support.`,
    "unknown-version": msg`This workflow file uses a version this app cannot read.`,
    "unsafe-path": msg`The archive contains an unsafe file path.`,
};

/**
 * Exports the open workflow as a `.zip` bundle and imports one (a bundle or a plain
 * `.json`). The canvas controls only call these; the bundle rules live in
 * `utils/workflow-bundle.ts`, and the file transfer goes through the chat upload path.
 */
export const useWorkflowTransfer = () => {
    const { i18n, t } = useLingui();
    const lunora = useLunora();
    const [isTransferring, setIsTransferring] = useState(false);

    const exportWorkflow = useCallback(async () => {
        setIsTransferring(true);

        try {
            const { blob, skipped } = await exportWorkflowBundle(useWorkflowStore.getState().getContent(), {
                createZip: createJsZip,
                fetchBytes: downloadBundleSource,
                // The bundle holds stored chat files as plain strings; the query takes the typed id.
                signUrl: (fileId) => lunora.query(api.file.getChatFileImageUrl, { fileId: fileId as Id<"chatFiles"> }),
            });

            saveBlob(blob, "workflow.zip");

            if (skipped > 0) {
                showError(i18n._(msg`${plural(skipped, { one: "# file", other: "# files" })} could not be included in the export`));
            }
        } catch {
            showError(t`Could not export the workflow`);
        } finally {
            setIsTransferring(false);
        }
    }, [i18n, lunora, t]);

    const importWorkflow = useCallback(
        async (file: File) => {
            setIsTransferring(true);

            try {
                const bundle = await readWorkflowBundle(file, { loadZip: loadJsZip });
                const { content, skipped } = await importWorkflowBundle(bundle, (assetFile) => uploadChatAttachment(lunora, assetFile));

                useWorkflowStore.getState().importContent(content);

                if (skipped > 0) {
                    showError(
                        i18n._(
                            msg`${plural(skipped, { one: "# file could not be imported and was", other: "# files could not be imported and were" })} left out`,
                        ),
                    );
                }
            } catch (error) {
                showError(error instanceof WorkflowBundleError ? i18n._(BUNDLE_ERROR_MESSAGES[error.code]) : t`Could not import the workflow`);
            } finally {
                setIsTransferring(false);
            }
        },
        [i18n, lunora, t],
    );

    return { exportWorkflow, importWorkflow, isTransferring };
};
