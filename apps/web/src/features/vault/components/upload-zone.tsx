"use client";

import { Trans, useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import cn from "@neore/ui/utils/cn";
import { useMutation } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useCallback } from "react";
import { useDropzone } from "react-dropzone";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";
import { uploadFile } from "@/lib/upload/upload-file";

import { showError, showSuccess } from "../../../lib/toast";

type Properties = {
    children: ReactNode;
    onUpload?: (
        results: {
            fileName: string;
            fileSize: number;
            fileType: string;
        }[],
    ) => void;
};

const VaultUploadZone = ({ children, onUpload }: Properties) => {
    const { t } = useLingui();
    // saveVaultFile is an action — use useLunoraActionOptions.
    // `mutateAsync` is destructured out because the mutation object itself is not
    // referentially stable, so it cannot go in a dependency array.
    const { mutateAsync: saveVaultFile } = useMutation(useLunoraActionOptions(api.vault.functions.saveVaultFile));

    const onDrop = useCallback(
        async (acceptedFiles: File[]) => {
            if (acceptedFiles.length === 0) {
                return;
            }

            try {
                for (const file of acceptedFiles) {
                    // Send the bytes to the upload route, then take the upload into the vault.
                    const uploadId = await uploadFile(file, { contentType: file.type });

                    await saveVaultFile({ fileName: file.name, uploadId });

                    const fileName = file.name;

                    showSuccess(t`Uploaded ${fileName}`);
                }

                // Callback with results
                const results = acceptedFiles.map((file) => {
                    return {
                        fileName: file.name,
                        fileSize: file.size,
                        fileType: file.type,
                    };
                });

                onUpload?.(results);
            } catch (error) {
                console.error("Upload error:", error);
                showError(t`Failed to upload files. Please try again.`);
            }
        },
        [saveVaultFile, onUpload, t],
    );

    const { getInputProps, getRootProps, isDragActive } = useDropzone({
        accept: {
            "application/msword": [".doc"],
            "application/pdf": [".pdf"],
            "application/vnd.ms-excel": [".xls"],
            "application/vnd.ms-powerpoint": [".ppt"],
            "application/vnd.openxmlformats-officedocument.presentationml.presentation": [".pptx"],
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [".xlsx"],
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
            "application/zip": [".zip"],
            "image/*": [".jpg", ".jpeg", ".png", ".webp", ".gif", ".svg"],
            "text/markdown": [".md"],
            "text/plain": [".txt"],
        },
        maxFiles: 25,
        maxSize: 5 * 1024 * 1024, // 5MB
        multiple: true,
        onDrop,
        onDropRejected: (fileRejections) => {
            const rejection = fileRejections[0];

            if (rejection?.errors.find(({ code }) => code === "file-too-large")) {
                showError(t`File size too large. Maximum 5MB allowed.`);
            } else if (rejection?.errors.find(({ code }) => code === "file-invalid-type")) {
                showError(t`File type not supported.`);
            } else {
                showError(t`File upload rejected.`);
            }
        },
    });

    return (
        <div className="relative h-full" {...getRootProps({ onClick: (event_) => event_.stopPropagation() })}>
            {/* Drag Overlay */}
            <div className="pointer-events-none absolute top-0 right-0 left-0 z-[51] h-full w-full">
                <div
                    className={cn(
                        "bg-background flex h-full w-full items-center justify-center text-center dark:bg-[#1A1A1A]",
                        isDragActive ? "visible" : "invisible",
                    )}
                >
                    <input {...getInputProps()} id="upload-files" />

                    <div className="flex flex-col items-center justify-center gap-2">
                        <p className="text-sm">
                            <Trans>
                                Drop your documents and files here. <br />
                                Maximum of 25 files at a time.
                            </Trans>
                        </p>

                        <span className="text-xs text-[#878787]">
                            <Trans>Max file size 5MB</Trans>
                        </span>
                    </div>
                </div>
            </div>

            {children}
        </div>
    );
};

export default VaultUploadZone;
