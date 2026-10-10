"use client";

/**
 * FileMentionPopup - Suggestion popup for @ file attachment triggers
 *
 * Shows vault files the user has access to when the user types `@`.
 * Selecting a vault file attaches it to the message. Also offers an
 * "Upload new file" option that opens the file picker.
 *
 * In a group-chat thread the participants come first: picking one inserts
 * `@<slug> `, which makes that participant answer (`chat/group/` backend).
 */

import { useLingui } from "@lingui/react/macro";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "@neore/ui/components/command";
import { skipToken, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { FileIcon, FileImage, FileText, UploadIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import { SpeakerAvatar } from "@/features/chat/group/speaker-label";
import { useRouteGroupChat } from "@/features/chat/group/use-group-chat";
import { formatFileSize } from "@/features/vault/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

import type { FileMentionMatch } from "./extensions/file-mention";

// ============================================================================
// Types
// ============================================================================

export interface VaultFileRef {
    _id: string;
    fileName: string;
    fileSize: number;
    fileType: string;
    url?: string;
}

interface FileMentionPopupProps {
    /** Rect of the editor element for positioning */
    editorRect: DOMRect | null;
    match: FileMentionMatch | null;
    /** Called to dismiss the popup */
    onDismiss: () => void;
    /** Called to replace the @ text range in the editor */
    onReplace: (from: number, to: number, replacement: string) => void;
    /** Called when "Upload new file" is selected */
    onSelectFileUpload?: () => void;
    /** Called when a vault file is selected for attachment */
    onSelectVaultFile?: (file: VaultFileRef) => void;
}

const MENU_WIDTH = 340;

// ============================================================================
// Helpers
// ============================================================================

const getFileTypeIcon = (fileType: string) => {
    if (fileType.startsWith("image/")) {
        return FileImage;
    }

    if (fileType === "application/pdf" || fileType.includes("text/")) {
        return FileText;
    }

    return FileIcon;
};

// ============================================================================
// Main Component
// ============================================================================

const FileMentionPopup: FC<FileMentionPopupProps> = ({ editorRect, match, onDismiss, onReplace, onSelectFileUpload, onSelectVaultFile }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [searchQuery, setSearchQuery] = useState("");

    // Fetch vault files — once an @-mention opens the popup, not on first paint
    // (the editor mounts this popup permanently; see `e2e/first-paint.e2e.test.ts`).
    const { data: vaultFiles = [] } = useQuery(crpc.vault.functions.getAttachmentsForUser.queryOptions(match === null ? skipToken : {}));

    // Filter files by query (from @ trigger or search input)
    const filteredFiles = useMemo(() => {
        const query = (searchQuery || match?.query || "").toLowerCase();

        if (!query) {
            return vaultFiles;
        }

        return vaultFiles.filter((f) => f.fileName.toLowerCase().includes(query) || f.fileType.toLowerCase().includes(query));
    }, [vaultFiles, match?.query, searchQuery]);

    // Group chat: participants that can be @mentioned, filtered like the files.
    const groupChat = useRouteGroupChat();
    const filteredParticipants = useMemo(() => {
        const query = (searchQuery || match?.query || "").toLowerCase();
        const available = (groupChat?.participants ?? []).filter((p) => p.available && p.slug);

        return query ? available.filter((p) => p.slug.includes(query) || p.name.toLowerCase().includes(query)) : available;
    }, [groupChat, match?.query, searchQuery]);
    const participantCount = filteredParticipants.length;

    // Total items: participants + 1 for "Upload new file" + filtered files
    const totalItems = participantCount + filteredFiles.length + 1;

    const isOpen = match !== null;

    // Reset the highlighted row whenever the list length changes, and clear the search once the
    // popup closes. Adjusting during render (rather than in an effect) avoids painting a frame
    // with the stale selection. See https://react.dev/learn/you-might-not-need-an-effect
    const [renderedItemCount, setRenderedItemCount] = useState(totalItems);

    if (renderedItemCount !== totalItems) {
        setRenderedItemCount(totalItems);
        setSelectedIndex(0);
    }

    if (!match && searchQuery !== "") {
        setSearchQuery("");
    }

    // Handle vault file selection
    const handleSelectFile = useCallback(
        (file: VaultFileRef) => {
            if (!match) {
                return;
            }

            // Remove the @ text from the editor
            onReplace(match.from, match.to, "");
            onSelectVaultFile?.(file);
            setSearchQuery("");
            onDismiss();
        },
        [match, onReplace, onSelectVaultFile, onDismiss],
    );

    // Insert the participant's handle in place of the typed `@query`.
    const handleSelectParticipant = useCallback(
        (slug: string) => {
            if (!match) {
                return;
            }

            onReplace(match.from, match.to, `@${slug} `);
            setSearchQuery("");
            onDismiss();
        },
        [match, onReplace, onDismiss],
    );

    // Handle "Upload new file" selection
    const handleUploadNew = useCallback(() => {
        if (!match) {
            return;
        }

        // Remove the @ text from the editor
        onReplace(match.from, match.to, "");
        onSelectFileUpload?.();
        setSearchQuery("");
        onDismiss();
    }, [match, onReplace, onSelectFileUpload, onDismiss]);

    const onKeyDown = useEffectEvent((event: KeyboardEvent) => {
        if (event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            setSelectedIndex((previous) => (previous + 1) % totalItems);
        } else if (event.key === "ArrowUp") {
            event.preventDefault();
            event.stopPropagation();
            setSelectedIndex((previous) => (previous - 1 + totalItems) % totalItems);
        } else if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            event.stopPropagation();

            if (selectedIndex < participantCount) {
                const participant = filteredParticipants[selectedIndex];

                if (participant) {
                    handleSelectParticipant(participant.slug);
                }
            } else if (selectedIndex === participantCount) {
                // "Upload new file" follows the participants
                handleUploadNew();
            } else {
                const file = filteredFiles[selectedIndex - participantCount - 1];

                if (file) {
                    handleSelectFile(file);
                }
            }
        } else if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onDismiss();
        }
    });

    // Keyboard navigation
    useEffect(() => {
        if (!isOpen) {
            return undefined;
        }

        const handleKeyDown = (event: KeyboardEvent) => onKeyDown(event);

        globalThis.addEventListener("keydown", handleKeyDown, { capture: true });

        return () => globalThis.removeEventListener("keydown", handleKeyDown, true);
    }, [isOpen]);

    if (!isOpen || !editorRect) {
        return null;
    }

    const position = {
        left: editorRect.left,
        top: editorRect.top,
    };

    return createPortal(
        <div
            className="fixed z-50"
            style={{
                left: `${position.left}px`,
                top: `${position.top}px`,
                transform: "translateY(-100%)",
            }}
        >
            <div
                className={clsx(
                    "overflow-hidden rounded-lg border",
                    "bg-popover text-popover-foreground",
                    "dark:bg-[oklch(0.205_0_0)] dark:text-[oklch(0.985_0_0)]",
                    "border-border dark:border-white/10",
                    "shadow-md dark:shadow-xl dark:shadow-black/50",
                    "ring-foreground/10 ring-1 dark:ring-white/10",
                    "animate-in fade-in-0 zoom-in-95 slide-in-from-bottom-2",
                )}
                style={{ width: MENU_WIDTH }}
            >
                <Command>
                    <CommandInput onChange={(e) => setSearchQuery(e.target.value)} placeholder={t`Search files...`} value={searchQuery} />
                    <CommandList className="max-h-[300px]">
                        {/* Group chat participants - first, when the thread has them */}
                        {participantCount > 0 && (
                            <>
                                <CommandGroup>
                                    <CommandGroupLabel>{t`Participants`}</CommandGroupLabel>
                                    {filteredParticipants.map((participant, index) => (
                                        <CommandItem
                                            className={clsx("transition-colors", index === selectedIndex && "bg-accent text-accent-foreground")}
                                            key={participant.skillId}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                handleSelectParticipant(participant.slug);
                                            }}
                                            value={`participant:${participant.skillId}`}
                                        >
                                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                                <SpeakerAvatar name={participant.name} />
                                                <div className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium">{participant.name}</span>
                                                    <span className="text-muted-foreground block truncate text-xs">@{participant.slug}</span>
                                                </div>
                                            </div>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                                <CommandSeparator />
                            </>
                        )}

                        {/* Upload new file option */}
                        <CommandGroup>
                            <CommandGroupLabel>{t`Actions`}</CommandGroupLabel>
                            <CommandItem
                                className={clsx("transition-colors", selectedIndex === participantCount && "bg-accent text-accent-foreground")}
                                onClick={(e) => {
                                    e.preventDefault();
                                    handleUploadNew();
                                }}
                                value="__upload_new__"
                            >
                                <div className="flex min-w-0 flex-1 items-center gap-2">
                                    <UploadIcon className="text-muted-foreground size-4 shrink-0" />
                                    <span className="font-medium">{t`Upload new file`}</span>
                                </div>
                            </CommandItem>
                        </CommandGroup>

                        {filteredFiles.length > 0 && <CommandSeparator />}

                        {/* Vault files */}
                        {filteredFiles.length > 0 && (
                            <CommandGroup>
                                <CommandGroupLabel>{t`Vault files`}</CommandGroupLabel>
                                {filteredFiles.map((file, index) => {
                                    const Icon = getFileTypeIcon(file.fileType);

                                    return (
                                        <CommandItem
                                            className={clsx(
                                                "transition-colors",
                                                participantCount + index + 1 === selectedIndex && "bg-accent text-accent-foreground",
                                            )}
                                            key={file._id}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                handleSelectFile(file);
                                            }}
                                            value={file._id}
                                        >
                                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                                <Icon className="text-muted-foreground size-4 shrink-0" />
                                                <div className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium">{file.fileName}</span>
                                                    <span className="text-muted-foreground block truncate text-xs">{formatFileSize(file.fileSize)}</span>
                                                </div>
                                            </div>
                                        </CommandItem>
                                    );
                                })}
                            </CommandGroup>
                        )}

                        {filteredFiles.length === 0 && searchQuery && (
                            <CommandEmpty>
                                <div className="flex flex-col items-center gap-2 py-6">
                                    <FileIcon className="text-muted-foreground size-8" />
                                    <p className="text-muted-foreground text-sm">{t`No files found`}</p>
                                </div>
                            </CommandEmpty>
                        )}
                    </CommandList>
                </Command>
            </div>
        </div>,
        document.body,
    );
};

export default FileMentionPopup;
