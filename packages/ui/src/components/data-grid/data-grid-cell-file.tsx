"use client";

import type { I18n } from "@lingui/core";
import { msg, plural } from "@lingui/core/macro";
import { Plural, useLingui } from "@lingui/react/macro";
import type { RowData } from "@tanstack/react-table";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import DataGridCellWrapper from "@ui/components/data-grid/data-grid-cell-wrapper";
import { formatFileSize } from "@ui/components/file-renderers/file-type-utilities";
import { Popover, PopoverAnchor, PopoverContent } from "@ui/components/popover";
import { Skeleton } from "@ui/components/skeleton";
import { useBadgeOverflow } from "@ui/hooks/use-badge-overflow";
import { getCellKey, getLineCount, overlapAnchor } from "@ui/lib/data-grid";
import type { DataGridCellProps, FileCellData } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import { File, FileArchive, FileAudio, FileImage, FileSpreadsheet, FileText, FileVideo, Presentation, Upload, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";

const getFileIcon = (type: string): React.ComponentType<React.SVGProps<SVGSVGElement>> => {
    if (type.startsWith("image/")) {
        return FileImage;
    }

    if (type.startsWith("video/")) {
        return FileVideo;
    }

    if (type.startsWith("audio/")) {
        return FileAudio;
    }

    if (type.includes("pdf")) {
        return FileText;
    }

    if (type.includes("zip") || type.includes("rar")) {
        return FileArchive;
    }

    if (type.includes("word") || type.includes("document") || type.includes("doc")) {
        return FileText;
    }

    if (type.includes("sheet") || type.includes("excel") || type.includes("xls")) {
        return FileSpreadsheet;
    }

    if (type.includes("presentation") || type.includes("powerpoint") || type.includes("ppt")) {
        return Presentation;
    }

    return File;
};

const getDropzoneHint = (i18n: I18n, maxFileSize: number | undefined, maxFiles: number | undefined): string => {
    if (maxFileSize) {
        const size = formatFileSize(maxFileSize);

        return maxFiles ? i18n._(msg`Max size: ${size} • Max ${maxFiles} files`) : i18n._(msg`Max size: ${size}`);
    }

    if (maxFiles) {
        return i18n._(msg`Max ${maxFiles} files`);
    }

    return i18n._(msg`Select files to upload`);
};

const getFileStatusLabel = (i18n: I18n, isFileUploading: boolean, isFileDeleting: boolean, size: number): string => {
    if (isFileUploading) {
        return i18n._(msg`Uploading...`);
    }

    if (isFileDeleting) {
        return i18n._(msg`Deleting...`);
    }

    return formatFileSize(size);
};

export const FileCell = <TData extends RowData>({
    cell,
    columnId,
    isActiveSearchMatch,
    isEditing,
    isFocused,
    isSearchMatch,
    isSelected,
    readOnly,
    rowHeight,
    rowIndex,
    tableMeta,
}: DataGridCellProps<TData>) => {
    const { i18n, t } = useLingui();
    const cellValue = React.useMemo(() => (cell.getValue() as FileCellData[]) ?? [], [cell]);

    const cellKey = getCellKey(rowIndex, columnId);
    const [prevCellKey, setPrevCellKey] = React.useState(cellKey);

    const labelId = React.useId();
    const descriptionId = React.useId();

    const [files, setFiles] = React.useState<FileCellData[]>(cellValue);
    const [uploadingFiles, setUploadingFiles] = React.useState<Set<string>>(new Set());
    const [deletingFiles, setDeletingFiles] = React.useState<Set<string>>(new Set());
    const [isDraggingOver, setIsDraggingOver] = React.useState(false);
    const [isDragging, setIsDragging] = React.useState(false);
    const [error, setError] = React.useState<string | null>(null);

    const isUploading = uploadingFiles.size > 0;
    const isDeleting = deletingFiles.size > 0;
    const isPending = isUploading || isDeleting;
    const containerRef = React.useRef<HTMLDivElement>(null);
    const fileInputRef = React.useRef<HTMLInputElement>(null);
    const dropzoneRef = React.useRef<HTMLDivElement>(null);
    const cellOptions = cell.column.columnDef.meta?.cell;

    const fileCellOptions = cellOptions?.variant === "file" ? cellOptions : null;
    const maxFileSize = fileCellOptions?.maxFileSize ?? 10 * 1024 * 1024;
    const maxFiles = fileCellOptions?.maxFiles ?? 10;
    const accept = fileCellOptions?.accept;
    const multiple = fileCellOptions?.multiple ?? false;

    const acceptedTypes = React.useMemo(() => (accept ? accept.split(",").map((type) => type.trim()) : null), [accept]);

    const [prevCellValue, setPrevCellValue] = React.useState(cellValue);

    if (cellValue !== prevCellValue) {
        setPrevCellValue(cellValue);

        for (const file of files) {
            if (file.url) {
                URL.revokeObjectURL(file.url);
            }
        }

        setFiles(cellValue);
        setError(null);
    }

    if (prevCellKey !== cellKey) {
        setPrevCellKey(cellKey);
        setError(null);
    }

    const validateFile = React.useCallback(
        (file: File): string | null => {
            if (maxFileSize && file.size > maxFileSize) {
                const maxSize = formatFileSize(maxFileSize);

                return t`File size exceeds ${maxSize}`;
            }

            if (acceptedTypes) {
                const fileExtension = `.${file.name.split(".").pop()}`;
                const isAccepted = acceptedTypes.some((type) => {
                    if (type.endsWith("/*")) {
                        const baseType = type.slice(0, -2);

                        return file.type.startsWith(`${baseType}/`);
                    }

                    if (type.startsWith(".")) {
                        return fileExtension.toLowerCase() === type.toLowerCase();
                    }

                    return file.type === type;
                });

                if (!isAccepted) {
                    return t`File type not accepted`;
                }
            }

            return null;
        },
        [maxFileSize, acceptedTypes, t],
    );

    const addFiles = React.useCallback(
        async (newFiles: File[], skipUpload = false) => {
            if (readOnly || isPending) {
                return;
            }

            setError(null);

            if (maxFiles && files.length + newFiles.length > maxFiles) {
                const errorMessage = t`Maximum ${maxFiles} files allowed`;

                setError(errorMessage);
                toast(errorMessage);
                setTimeout(() => {
                    setError(null);
                }, 2000);

                return;
            }

            const rejectedFiles: { name: string; reason: string }[] = [];
            const filesToValidate: File[] = [];

            for (const file of newFiles) {
                const validationError = validateFile(file);

                if (validationError) {
                    rejectedFiles.push({ name: file.name, reason: validationError });
                    continue;
                }

                filesToValidate.push(file);
            }

            if (rejectedFiles.length > 0) {
                const firstError = rejectedFiles[0];

                if (firstError) {
                    setError(firstError.reason);

                    const truncatedName = firstError.name.length > 20 ? `${firstError.name.slice(0, 20)}...` : firstError.name;

                    if (rejectedFiles.length === 1) {
                        toast(firstError.reason, {
                            description: t`"${truncatedName}" has been rejected`,
                        });
                    } else {
                        const moreCount = rejectedFiles.length - 1;

                        toast(firstError.reason, {
                            description: t`"${truncatedName}" and ${moreCount} more rejected`,
                        });
                    }

                    setTimeout(() => {
                        setError(null);
                    }, 2000);
                }
            }

            if (filesToValidate.length > 0) {
                if (skipUpload) {
                    const newFilesData: FileCellData[] = filesToValidate.map((f) => {
                        return {
                            id: crypto.randomUUID(),
                            name: f.name,
                            size: f.size,
                            type: f.type,
                            url: URL.createObjectURL(f),
                        };
                    });
                    const updatedFiles = [...files, ...newFilesData];

                    setFiles(updatedFiles);
                    tableMeta?.onDataUpdate?.({
                        columnId,
                        rowIndex,
                        value: updatedFiles,
                    });
                } else {
                    const tempFiles = filesToValidate.map((f) => {
                        return {
                            id: crypto.randomUUID(),
                            name: f.name,
                            size: f.size,
                            type: f.type,
                            url: undefined,
                        };
                    });
                    const filesWithTemp = [...files, ...tempFiles];

                    setFiles(filesWithTemp);

                    const uploadingIds = new Set(tempFiles.map((f) => f.id));

                    setUploadingFiles(uploadingIds);

                    let uploadedFiles: FileCellData[] = [];

                    if (tableMeta?.onFilesUpload) {
                        try {
                            uploadedFiles = await tableMeta.onFilesUpload({
                                columnId,
                                files: filesToValidate,
                                rowIndex,
                            });
                        } catch (uploadError) {
                            const fileCount = filesToValidate.length;
                            // eslint-disable-next-line no-restricted-syntax -- a Lingui plural must be the whole message of `t`
                            const uploadFailedMessage = t`${plural(fileCount, { one: "Failed to upload # file", other: "Failed to upload # files" })}`;

                            toast.error(uploadError instanceof Error ? uploadError.message : uploadFailedMessage);
                            setFiles((prev) => prev.filter((f) => !uploadingIds.has(f.id as `${string}-${string}-${string}-${string}-${string}`)));
                            setUploadingFiles(new Set());

                            return;
                        }
                    } else {
                        uploadedFiles = filesToValidate.map((f, i) => {
                            return {
                                id: tempFiles[i]?.id ?? crypto.randomUUID(),
                                name: f.name,
                                size: f.size,
                                type: f.type,
                                url: URL.createObjectURL(f),
                            };
                        });
                    }

                    const finalFiles = filesWithTemp
                        .map((f) => {
                            if (uploadingIds.has(f.id as `${string}-${string}-${string}-${string}-${string}`)) {
                                return uploadedFiles.find((uf) => uf.name === f.name) ?? f;
                            }

                            return f;
                        })
                        .filter((f) => f.url !== undefined);

                    setFiles(finalFiles);
                    setUploadingFiles(new Set());
                    tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: finalFiles });
                }
            }
        },
        [files, maxFiles, validateFile, tableMeta, rowIndex, columnId, readOnly, isPending, t],
    );

    const removeFile = React.useCallback(
        async (fileId: string) => {
            if (readOnly || isPending) {
                return;
            }

            setError(null);

            const fileToRemove = files.find((f) => f.id === fileId);

            if (!fileToRemove) {
                return;
            }

            setDeletingFiles((prev) => new Set(prev).add(fileId));

            if (tableMeta?.onFilesDelete) {
                try {
                    await tableMeta.onFilesDelete({
                        columnId,
                        fileIds: [fileId],
                        rowIndex,
                    });
                } catch (deleteError) {
                    const fileName = fileToRemove.name;

                    toast.error(deleteError instanceof Error ? deleteError.message : t`Failed to delete ${fileName}`);
                    setDeletingFiles((prev) => {
                        const next = new Set(prev);

                        next.delete(fileId);

                        return next;
                    });

                    return;
                }
            }

            if (fileToRemove.url?.startsWith("blob:")) {
                URL.revokeObjectURL(fileToRemove.url);
            }

            const updatedFiles = files.filter((f) => f.id !== fileId);

            setFiles(updatedFiles);
            setDeletingFiles((prev) => {
                const next = new Set(prev);

                next.delete(fileId);

                return next;
            });
            tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: updatedFiles });
        },
        [files, tableMeta, rowIndex, columnId, readOnly, isPending, t],
    );

    const clearAll = React.useCallback(async () => {
        if (readOnly || isPending) {
            return;
        }

        setError(null);

        const fileIds = files.map((f) => f.id);

        setDeletingFiles(new Set(fileIds));

        if (tableMeta?.onFilesDelete && files.length > 0) {
            try {
                await tableMeta.onFilesDelete({
                    columnId,
                    fileIds,
                    rowIndex,
                });
            } catch (deleteError) {
                toast.error(deleteError instanceof Error ? deleteError.message : t`Failed to delete files`);
                setDeletingFiles(new Set());

                return;
            }
        }

        for (const file of files) {
            if (file.url?.startsWith("blob:")) {
                URL.revokeObjectURL(file.url);
            }
        }

        setFiles([]);
        setDeletingFiles(new Set());
        tableMeta?.onDataUpdate?.({ columnId, rowIndex, value: [] });
    }, [files, tableMeta, rowIndex, columnId, readOnly, isPending, t]);

    const onCellDragEnter = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();

        if (event.dataTransfer.types.includes("Files")) {
            setIsDraggingOver(true);
        }
    }, []);

    const onCellDragLeave = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;

        if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
            setIsDraggingOver(false);
        }
    }, []);

    const onCellDragOver = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
    }, []);

    const onCellDrop = React.useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setIsDraggingOver(false);

            const droppedFiles = [...event.dataTransfer.files];

            if (droppedFiles.length > 0) {
                addFiles(droppedFiles, false);
            }
        },
        [addFiles],
    );

    const onDropzoneDragEnter = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        setIsDragging(true);
    }, []);

    const onDropzoneDragLeave = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        const x = event.clientX;
        const y = event.clientY;

        if (x <= rect.left || x >= rect.right || y <= rect.top || y >= rect.bottom) {
            setIsDragging(false);
        }
    }, []);

    const onDropzoneDragOver = React.useCallback((event: React.DragEvent) => {
        event.preventDefault();
        event.stopPropagation();
    }, []);

    const onDropzoneDrop = React.useCallback(
        (event: React.DragEvent) => {
            event.preventDefault();
            event.stopPropagation();
            setIsDragging(false);

            const droppedFiles = [...event.dataTransfer.files];

            addFiles(droppedFiles, false);
        },
        [addFiles],
    );

    const onDropzoneClick = React.useCallback(() => {
        fileInputRef.current?.click();
    }, []);

    const onDropzoneKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (!(event.key === "Enter" || event.key === " ")) {
                return;
            }

            event.preventDefault();
            onDropzoneClick();
        },
        [onDropzoneClick],
    );

    const onFileInputChange = React.useCallback(
        (event: React.ChangeEvent<HTMLInputElement>) => {
            const selectedFiles = [...(event.target.files ?? [])];

            addFiles(selectedFiles, false);

            // Clearing the input is what makes re-picking the same file fire
            // `change` again.
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        },
        [addFiles],
    );

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            setError(null);

            if (open && !readOnly) {
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else {
                tableMeta?.onCellEditingStop?.();
            }
        },
        [tableMeta, rowIndex, columnId, readOnly],
    );

    const onWrapperKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (isEditing) {
                if (event.key === "Escape") {
                    event.preventDefault();
                    setFiles(cellValue);
                    setError(null);
                    tableMeta?.onCellEditingStop?.();
                } else if (event.key === " ") {
                    event.preventDefault();
                    onDropzoneClick();
                }
            } else if (isFocused && event.key === "Enter") {
                event.preventDefault();
                tableMeta?.onCellEditingStart?.(rowIndex, columnId);
            } else if (!isEditing && isFocused && event.key === "Tab") {
                event.preventDefault();
                tableMeta?.onCellEditingStop?.({
                    direction: event.shiftKey ? "left" : "right",
                });
            }
        },
        [isEditing, isFocused, cellValue, tableMeta, onDropzoneClick, rowIndex, columnId],
    );

    React.useEffect(
        () => () => {
            for (const file of files) {
                if (file.url) {
                    URL.revokeObjectURL(file.url);
                }
            }
        },
        [files],
    );

    const lineCount = getLineCount(rowHeight);

    const { hiddenCount: hiddenFileCount, visibleItems: visibleFiles } = useBadgeOverflow({
        cacheKeyPrefix: "file",
        containerRef,
        getLabel: (file) => file.name,
        iconSize: 12,
        items: files,
        lineCount,
        maxWidth: 100,
    });

    const fileBadges =
        files.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1 overflow-hidden">
                {visibleFiles.map((file) => {
                    const isFileUploading = uploadingFiles.has(file.id);

                    if (isFileUploading) {
                        return (
                            <Skeleton
                                className="h-5 shrink-0 px-1.5"
                                key={file.id}
                                style={{
                                    width: `${Math.min(file.name.length * 8 + 30, 100)}px`,
                                }}
                            />
                        );
                    }

                    const FileIcon = getFileIcon(file.type);

                    return (
                        <Badge className="gap-1 px-1.5 py-px" key={file.id} variant="secondary">
                            {FileIcon && <FileIcon className="size-3 shrink-0" />}
                            <span className="max-w-[100px] truncate">{file.name}</span>
                        </Badge>
                    );
                })}
                {hiddenFileCount > 0 && (
                    <Badge className="text-muted-foreground px-1.5 py-px" variant="outline">
                        +{hiddenFileCount}
                    </Badge>
                )}
            </div>
        ) : null;

    return (
        <DataGridCellWrapper<TData>
            cell={cell}
            className={cn({
                "ring-primary/80 ring-1 ring-inset": isDraggingOver,
            })}
            columnId={columnId}
            isActiveSearchMatch={isActiveSearchMatch}
            isEditing={isEditing}
            isFocused={isFocused}
            isSearchMatch={isSearchMatch}
            isSelected={isSelected}
            onDragEnter={onCellDragEnter}
            onDragLeave={onCellDragLeave}
            onDragOver={onCellDragOver}
            onDrop={onCellDrop}
            onKeyDown={onWrapperKeyDown}
            readOnly={readOnly}
            ref={containerRef}
            rowHeight={rowHeight}
            rowIndex={rowIndex}
            tableMeta={tableMeta}
        >
            {isEditing ? (
                <Popover onOpenChange={onOpenChange} open={isEditing}>
                    <PopoverAnchor nativeButton={false} render={<div className="absolute inset-0" />} />
                    <PopoverContent
                        align="start"
                        className="w-[400px] rounded-none p-0"
                        data-grid-cell-editor=""
                        initialFocus={dropzoneRef}
                        sideOffset={overlapAnchor}
                    >
                        <div className="flex flex-col gap-2 p-3">
                            <span className="sr-only" id={labelId}>
                                {t`File upload`}
                            </span>
                            <div
                                aria-describedby={descriptionId}
                                aria-disabled={isPending}
                                aria-labelledby={labelId}
                                className="hover:bg-accent/30 focus-visible:border-ring/50 data-dragging:border-primary/30 data-invalid:border-destructive data-dragging:bg-accent/30 data-invalid:ring-destructive/20 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed p-6 transition-colors outline-none data-disabled:pointer-events-none data-disabled:opacity-50"
                                data-disabled={isPending ? "" : undefined}
                                data-dragging={isDragging ? "" : undefined}
                                data-invalid={error ? "" : undefined}
                                onClick={onDropzoneClick}
                                onDragEnter={onDropzoneDragEnter}
                                onDragLeave={onDropzoneDragLeave}
                                onDragOver={onDropzoneDragOver}
                                onDrop={onDropzoneDrop}
                                onKeyDown={onDropzoneKeyDown}
                                ref={dropzoneRef}
                                role="button"
                                tabIndex={isDragging || isPending ? -1 : 0}
                            >
                                <Upload className="text-muted-foreground size-8" />
                                <div className="text-center text-sm">
                                    <p className="font-medium">{isDragging ? t`Drop files here` : t`Drag files here`}</p>
                                    <p className="text-muted-foreground text-xs">{t`or click to browse`}</p>
                                </div>
                                <p className="text-muted-foreground text-xs" id={descriptionId}>
                                    {getDropzoneHint(i18n, maxFileSize, maxFiles)}
                                </p>
                            </div>
                            <input
                                accept={accept}
                                aria-describedby={descriptionId}
                                aria-labelledby={labelId}
                                className="sr-only"
                                multiple={multiple}
                                onChange={onFileInputChange}
                                ref={fileInputRef}
                                type="file"
                            />
                            {files.length > 0 && (
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center justify-between">
                                        <p className="text-muted-foreground text-xs font-medium">
                                            <Plural one="# file" other="# files" value={files.length} />
                                        </p>
                                        <Button
                                            className="text-muted-foreground h-6 text-xs"
                                            disabled={isPending}
                                            onClick={clearAll}
                                            size="sm"
                                            type="button"
                                            variant="ghost"
                                        >
                                            {t`Clear all`}
                                        </Button>
                                    </div>
                                    <div className="max-h-[200px] space-y-1 overflow-y-auto">
                                        {files.map((file) => {
                                            const FileIcon = getFileIcon(file.type);
                                            const isFileUploading = uploadingFiles.has(file.id);
                                            const isFileDeleting = deletingFiles.has(file.id);
                                            const isFilePending = isFileUploading || isFileDeleting;
                                            const fileName = file.name;

                                            return (
                                                <div
                                                    className="bg-muted/50 flex items-center gap-2 rounded-md border px-2 py-1.5 data-pending:opacity-60"
                                                    data-pending={isFilePending ? "" : undefined}
                                                    key={file.id}
                                                >
                                                    {FileIcon && <FileIcon className="text-muted-foreground size-4 shrink-0" />}
                                                    <div className="flex-1 overflow-hidden">
                                                        <p className="truncate text-sm">{file.name}</p>
                                                        <p className="text-muted-foreground text-xs">
                                                            {getFileStatusLabel(i18n, isFileUploading, isFileDeleting, file.size)}
                                                        </p>
                                                    </div>
                                                    <Button
                                                        aria-label={t`Remove ${fileName}`}
                                                        className="size-5 rounded-sm"
                                                        disabled={isPending}
                                                        onClick={() => removeFile(file.id)}
                                                        size="icon"
                                                        type="button"
                                                        variant="ghost"
                                                    >
                                                        <X className="size-3" />
                                                    </Button>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>
                    </PopoverContent>
                </Popover>
            ) : null}
            {isDraggingOver ? (
                <div className="text-primary flex items-center justify-center gap-2 text-sm">
                    <Upload className="size-4" />
                    <span>{t`Drop files here`}</span>
                </div>
            ) : (
                fileBadges
            )}
        </DataGridCellWrapper>
    );
};
