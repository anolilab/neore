"use client";

/**
 * The attachments of an `askUser` answer: the files picked in the card, each uploaded and finalized as it goes, and the
 * limits they are checked against. The card shows them and sends their ids with the answer (`answerAskUser`).
 */

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import {
    ASK_USER_FILE_MAX_BYTES,
    ASK_USER_FILE_TYPES,
    ASK_USER_FILES_TOTAL_MAX_BYTES,
    ASK_USER_IMAGE_MAX_BYTES,
    ASK_USER_MAX_FILES,
} from "@neore/backend/ask-user-limits";
import type { ChangeEvent } from "react";
import { useEffect, useRef, useState } from "react";

import { useAction } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";
import { downscaleOversizedImage } from "@/lib/upload/image-downscale";
import { uploadFile } from "@/lib/upload/upload-file";

/** A photo may be larger than the file limit as selected: it is re-encoded before upload. This caps what is read into memory. */
const IMAGE_SELECT_MAX_BYTES = 40 * 1024 * 1024;

/** The extension of a file name, with its dot. */
const EXTENSION = /\.[^.]*$/;

/** The name a re-encoded photo is saved under: its base name with the extension of the type it was encoded as. */
const renamedFor = (name: string, type: string): string => {
    const base = name.replace(EXTENSION, "");
    const extension = type === "image/jpeg" ? "jpg" : (type.split("/", 2)[1] ?? "");

    return extension ? `${base}.${extension}` : name;
};

/** The largest a selected file may be: a photo gets the wider limit, since it is re-encoded before upload. */
const selectLimitOf = (file: File): number => (file.type.startsWith("image/") ? IMAGE_SELECT_MAX_BYTES : ASK_USER_FILE_MAX_BYTES);

export interface AttachedFile {
    fileId: string;
    name: string;
    size: number;
}

export const useAskUserAttachments = () => {
    const { t } = useLingui();
    const finalizeUpload = useAction(api.file.finalizeChatUpload);
    const [files, setFiles] = useState<AttachedFile[]>([]);
    const [uploading, setUploading] = useState(false);
    // The last attach attempt's failures, kept in the card so they stay visible after the toast has gone.
    const [attachNotice, setAttachNotice] = useState<string | null>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const attachButtonRef = useRef<HTMLButtonElement>(null);
    // Bytes attached so far: a chip removed mid-selection gives its bytes back at once, so the next file is checked against what is left.
    const attachedBytes = useRef(0);
    // The ids of the chips attached now: a photo the server dedupes onto one of them adds no bytes.
    const attachedIds = useRef(new Set<string>());
    // Stops the selection in progress when the question is answered or dismissed, so no later file is uploaded or finalized.
    const uploadAbort = useRef<AbortController | null>(null);

    // A card that goes away (the thread changes, the message is removed) stops its selection in progress.
    useEffect(() => () => uploadAbort.current?.abort(), []);

    const cancelSelection = () => {
        uploadAbort.current?.abort();
    };

    const removeFile = (file: AttachedFile) => {
        attachedBytes.current -= file.size;
        attachedIds.current.delete(file.fileId);
        setFiles((current) => current.filter((item) => item.fileId !== file.fileId));
        // Focus stays in the card: the remove button goes, so the attach button takes it.
        attachButtonRef.current?.focus();
    };

    const attachFiles = async (event: ChangeEvent<HTMLInputElement>) => {
        setAttachNotice(null);

        const fileInput = event.target;
        const picked = [...(fileInput.files ?? [])];

        fileInput.value = "";

        const room = ASK_USER_MAX_FILES - files.length;
        const typed = picked.filter((file) => ASK_USER_FILE_TYPES.includes(file.type) && file.size <= selectLimitOf(file));
        const accepted = typed.slice(0, Math.max(room, 0));

        // The budget counts what is uploaded, so it is checked per file after re-encoding, below.
        attachedBytes.current = files.reduce((sum, file) => sum + file.size, 0);
        attachedIds.current = new Set(files.map((file) => file.fileId));

        if (accepted.length < picked.length) {
            showError(t`Only PNG, JPEG, WEBP or GIF images, and PDFs up to 10 MB, 20 MB in all and four at most.`);
        }

        if (accepted.length === 0) {
            return;
        }

        setUploading(true);

        const controller = new AbortController();

        uploadAbort.current = controller;

        // One file's failure does not stop the others: each is attached or named as failed. A file over a size limit is
        // named apart, since choosing it again cannot succeed.
        const failed: string[] = [];
        const tooLarge: string[] = [];
        let attachedThisRun = 0;

        try {
            for (const file of accepted) {
                if (controller.signal.aborted) {
                    break;
                }

                try {
                    // Photos are re-encoded below the provider's per-image limit, as the composer does; PDFs go as they are.
                    const prepared = file.type.startsWith("image/") ? await downscaleOversizedImage(file) : file;

                    // Some images cannot be re-encoded, so an image is checked against the provider's limit as it stands.
                    const limit = file.type.startsWith("image/") ? ASK_USER_IMAGE_MAX_BYTES : ASK_USER_FILE_MAX_BYTES;

                    if (prepared.size > limit) {
                        tooLarge.push(file.name);

                        continue;
                    }

                    if (attachedBytes.current + prepared.size > ASK_USER_FILES_TOTAL_MAX_BYTES) {
                        failed.push(file.name);

                        continue;
                    }

                    const uploadId = await uploadFile(prepared, { contentType: prepared.type, signal: controller.signal });

                    if (controller.signal.aborted) {
                        break;
                    }

                    // A re-encoded photo has the new type's extension, so the saved name matches the bytes uploaded.
                    const filename = prepared === file ? file.name : renamedFor(file.name, prepared.type);
                    const { fileId } = await finalizeUpload({ filename, uploadId });

                    // Dismissed while the upload was finalizing: the answer is gone, so this file must not reach the chips.
                    if (controller.signal.aborted) {
                        break;
                    }

                    // The server dedupes uploads by content: a photo that comes back with an id already attached adds nothing.
                    if (attachedIds.current.has(fileId)) {
                        continue;
                    }

                    // Counted only once the upload is in, so a failed one does not use up the budget.
                    attachedIds.current.add(fileId);
                    attachedBytes.current += prepared.size;
                    attachedThisRun += 1;
                    setFiles((current) => [...current, { fileId, name: filename, size: prepared.size }]);
                } catch {
                    // An upload cut short by a dismissal is not a failure to report.
                    if (!controller.signal.aborted) {
                        failed.push(file.name);
                    }
                }
            }
        } finally {
            setUploading(false);
        }

        if (tooLarge.length > 0 || failed.length > 0) {
            const notices: string[] = [];

            if (tooLarge.length > 0) {
                notices.push(t`Too large to attach: ${tooLarge.join(", ")}. Reduce the file and attach it again.`);
            }

            if (failed.length > 0) {
                notices.push(
                    attachedThisRun > 0
                        ? t`Could not attach ${failed.join(", ")}. The other files were attached; try those again.`
                        : t`Could not attach ${failed.join(", ")}. Try those again.`,
                );
            }

            const message = notices.join(" ");

            setAttachNotice(message);
            showError(message);
        }
    };

    return { attachButtonRef, attachFiles, attachNotice, cancelSelection, fileInputRef, files, removeFile, uploading };
};
