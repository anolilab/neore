"use client";

/**
 * FileMentionPopup - Suggestion popup for @ file attachment triggers
 *
 * Shows vault files the user has access to when the user types `@`.
 * Selecting a vault file attaches it to the message. Also offers an
 * "Upload new file" option that opens the file picker.
 *
 * Also offers your recent chats (never a locked one): picking one attaches
 * its text, so you can ask about it here.
 *
 * In a group-chat thread the participants come first: picking one inserts
 * `@<slug> `, which makes that participant answer (`chat/group/` backend).
 */

import { useLingui } from "@lingui/react/macro";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "@neore/ui/components/command";
import { skipToken, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { FileIcon, FileImage, FileText, MessageSquareIcon, UploadIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import useAllThreadsData from "@/features/chat/core/hooks/use-all-threads-data";
import { SpeakerAvatar } from "@/features/chat/group/speaker-label";
import { useRouteGroupChat } from "@/features/chat/group/use-group-chat";
import { formatFileSize } from "@/features/vault/lib/utilities";
import { useCRPC } from "@/lib/lunora/crpc";

import type { ChatReference } from "../chat-reference";
import { mentionableChats } from "../chat-reference";
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
    /** The chat being typed into; it is not offered as a reference */
    currentThreadId?: string;
    /** Rect of the editor element for positioning */
    editorRect: DOMRect | null;
    match: FileMentionMatch | null;
    /** Called to dismiss the popup */
    onDismiss: () => void;
    /** Called to replace the @ text range in the editor */
    onReplace: (from: number, to: number, replacement: string) => void;
    /** Called when a chat is selected, to attach its text */
    onSelectChat?: (chat: ChatReference) => void;
    /** Called when "Upload new file" is selected */
    onSelectFileUpload?: () => void;
    /** Called when a vault file is selected for attachment */
    onSelectVaultFile?: (file: VaultFileRef) => void;
}

const MENU_WIDTH = 340;

/** Chats shown in the menu; typing narrows them. */
const MAX_CHAT_SUGGESTIONS = 5;
/** Rows a typed chat search asks the server for: well past the suggestions shown, so a title match is not cut off by a busier one. */
const SEARCHED_CHAT_ROWS = 50;

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

const FileMentionPopup: FC<FileMentionPopupProps> = ({
    currentThreadId,
    editorRect,
    match,
    onDismiss,
    onReplace,
    onSelectChat,
    onSelectFileUpload,
    onSelectVaultFile,
}) => {
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

    const isOpen = match !== null;

    // The sidebar already holds this list (same query key), so opening the menu costs no request. It is one page, so a typed
    // search goes to the server instead: a chat older than that page is still found by its title.
    const { lunora: threads } = useAllThreadsData(isOpen && onSelectChat !== undefined);
    const chatSearch = (searchQuery || match?.query || "").trim();
    const crpc = useCRPC();
    const { data: searchedThreads } = useQuery(
        crpc.chat.functions.searchThreads.queryOptions(
            isOpen && onSelectChat !== undefined && chatSearch
                ? { excludeTemporary: true, paginationOpts: { cursor: null, endCursor: null, numItems: SEARCHED_CHAT_ROWS }, searchQuery: chatSearch }
                : skipToken,
            { live: false },
        ),
    );
    const filteredChats = useMemo(() => {
        const chats = mentionableChats(chatSearch && searchedThreads ? searchedThreads.page : threads, currentThreadId);

        return chats.slice(0, MAX_CHAT_SUGGESTIONS);
    }, [threads, searchedThreads, chatSearch, currentThreadId]);

    // Total items: participants + 1 for "Upload new file" + filtered files + chats
    const totalItems = participantCount + filteredFiles.length + filteredChats.length + 1;

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

    const handleSelectChat = useCallback(
        (chat: ChatReference) => {
            if (!match) {
                return;
            }

            onReplace(match.from, match.to, "");
            onSelectChat?.(chat);
            setSearchQuery("");
            onDismiss();
        },
        [match, onReplace, onSelectChat, onDismiss],
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
            } else if (selectedIndex <= participantCount + filteredFiles.length) {
                const file = filteredFiles[selectedIndex - participantCount - 1];

                if (file) {
                    handleSelectFile(file);
                }
            } else {
                const chat = filteredChats[selectedIndex - participantCount - filteredFiles.length - 1];

                if (chat) {
                    handleSelectChat(chat);
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
                    <CommandInput onChange={(e) => setSearchQuery(e.target.value)} placeholder={t`Search files and chats...`} value={searchQuery} />
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

                        {filteredChats.length > 0 && (
                            <>
                                {filteredFiles.length > 0 && <CommandSeparator />}
                                <CommandGroup>
                                    <CommandGroupLabel>{t`Chats`}</CommandGroupLabel>
                                    {filteredChats.map((chat, index) => (
                                        <CommandItem
                                            className={clsx(
                                                "transition-colors",
                                                participantCount + filteredFiles.length + index + 1 === selectedIndex && "bg-accent text-accent-foreground",
                                            )}
                                            key={chat.id}
                                            onClick={(e) => {
                                                e.preventDefault();
                                                handleSelectChat(chat);
                                            }}
                                            // The title is in the value so the popup's own search matches it; the id keeps it unique.
                                            value={`${chat.title} chat:${chat.id}`}
                                        >
                                            <div className="flex min-w-0 flex-1 items-center gap-2">
                                                <MessageSquareIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
                                                <span className="block truncate text-sm font-medium">{chat.title}</span>
                                            </div>
                                        </CommandItem>
                                    ))}
                                </CommandGroup>
                            </>
                        )}

                        {filteredFiles.length === 0 && filteredChats.length === 0 && searchQuery && (
                            <CommandEmpty>
                                <div className="flex flex-col items-center gap-2 py-6">
                                    <FileIcon className="text-muted-foreground size-8" />
                                    <p className="text-muted-foreground text-sm">{t`Nothing found`}</p>
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
