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
 * Files and chats from the current chat's project come first, under "In this project".
 *
 * In a group-chat thread the participants come first: picking one inserts
 * `@<slug> `, which makes that participant answer (`chat/group/` backend).
 */

import { useLingui } from "@lingui/react/macro";
import { Command, CommandEmpty, CommandGroup, CommandGroupLabel, CommandInput, CommandItem, CommandList, CommandSeparator } from "@neore/ui/components/command";
import { formatFileSize } from "@neore/ui/components/file-renderers/file-type-utilities";
import { keepPreviousData, skipToken, useQuery } from "@tanstack/react-query";
import clsx from "clsx";
import { FileIcon, FileImage, FileText, MessageSquareIcon, UploadIcon } from "lucide-react";
import type { FC } from "react";
import { createElement, Fragment, useCallback, useEffect, useEffectEvent, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import useAllThreadsData from "@/features/chat/core/hooks/use-all-threads-data";
import { SpeakerAvatar } from "@/features/chat/group/speaker-label";
import { useGroupChat } from "@/features/chat/group/use-group-chat";
import { useCRPC } from "@/lib/lunora/crpc";

import type { ChatReference } from "../chat-reference";
import { mentionableChats } from "../chat-reference";
import type { FileMentionMatch } from "./extensions/file-mention";
import { POPUP_ENTER_MOTION, POPUP_ROW_MOTION } from "./popup-motion";
import { partitionByProject, projectThreadIds } from "./project-mentions";

// ============================================================================
// Types
// ============================================================================

export interface VaultFileRef {
    _id: string;
    /** The chat it was uploaded in; places it in that chat's project */
    chatId?: string;
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

type MentionRow = { chat: ChatReference; kind: "chat" } | { file: VaultFileRef; kind: "file" };

interface MentionSection {
    key: string;
    label: string;
    rows: MentionRow[];
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

const FileRow: FC<{ file: VaultFileRef }> = ({ file }) => {
    const icon = createElement(getFileTypeIcon(file.fileType), { "aria-hidden": true, className: "text-muted-foreground size-4 shrink-0" });

    return (
        <div className="flex min-w-0 flex-1 items-center gap-2">
            {icon}
            <div className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{file.fileName}</span>
                <span className="text-muted-foreground block truncate text-xs">{formatFileSize(file.fileSize)}</span>
            </div>
        </div>
    );
};

const ChatRow: FC<{ chat: ChatReference }> = ({ chat }) => (
    <div className="flex min-w-0 flex-1 items-center gap-2">
        <MessageSquareIcon aria-hidden="true" className="text-muted-foreground size-4 shrink-0" />
        <span className="block truncate text-sm font-medium">{chat.title}</span>
    </div>
);

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
    // Until the field is typed in, the query is the @ trigger's; once it is, the field is the query, even when cleared.
    const [searchEdited, setSearchEdited] = useState(false);
    const activeQuery = searchEdited ? searchQuery : (match?.query ?? "");

    // Fetch vault files — once an @-mention opens the popup, not on first paint
    // (the editor mounts this popup permanently; see `e2e/first-paint.e2e.test.ts`).
    const { data: vaultFiles = [] } = useQuery(crpc.vault.functions.getAttachmentsForUser.queryOptions(match === null ? skipToken : {}));

    // Filter files by query (from @ trigger or search input)
    const filteredFiles = useMemo(() => {
        const query = activeQuery.toLowerCase();

        if (!query) {
            return vaultFiles;
        }

        return vaultFiles.filter((f) => f.fileName.toLowerCase().includes(query) || f.fileType.toLowerCase().includes(query));
    }, [vaultFiles, activeQuery]);

    // Group chat: participants that can be @mentioned, filtered like the files.
    const groupChat = useGroupChat(currentThreadId);
    const filteredParticipants = useMemo(() => {
        const query = activeQuery.toLowerCase();
        const available = (groupChat?.participants ?? []).filter((p) => p.available && p.slug);

        return query ? available.filter((p) => p.slug.includes(query) || p.name.toLowerCase().includes(query)) : available;
    }, [groupChat, activeQuery]);
    const participantCount = filteredParticipants.length;

    const isOpen = match !== null;

    // The sidebar already holds this list (same query key), so opening the menu costs no request. It is one page, so a typed
    // search goes to the server instead: a chat older than that page is still found by its title.
    const { lunora: threads } = useAllThreadsData(isOpen && onSelectChat !== undefined);
    const chatSearch = activeQuery.trim();
    // The previous result stays while a new keystroke's search loads. Until a search has answered, the loaded page is filtered by title here.
    const {
        data: searchedThreads,
        isError: searchFailed,
        isPlaceholderData,
    } = useQuery({
        ...crpc.chat.functions.searchThreads.queryOptions(
            isOpen && onSelectChat !== undefined && chatSearch
                ? { excludeTemporary: true, paginationOpts: { cursor: null, endCursor: null, numItems: SEARCHED_CHAT_ROWS }, searchQuery: chatSearch }
                : skipToken,
            { live: false },
        ),
        placeholderData: keepPreviousData,
    });
    const chatCandidates = useMemo(() => {
        const query = chatSearch.toLowerCase();
        const pending = threads.filter((thread) => thread.title?.toLowerCase().includes(query));
        // Only the answer to the query now typed: the previous one (kept while this one loads) and a failed search do not count.
        const answered = searchedThreads && !isPlaceholderData && !searchFailed ? searchedThreads.page : undefined;
        const chats = mentionableChats(chatSearch ? (answered ?? pending) : threads, currentThreadId);

        return { answered, chats };
    }, [threads, searchedThreads, isPlaceholderData, searchFailed, chatSearch, currentThreadId]);

    // The current chat's project, read from the chats already loaded: a searched chat outside the first page counts too.
    const inProject = useMemo(
        () => projectThreadIds(chatCandidates.answered ? [...threads, ...chatCandidates.answered] : threads, currentThreadId),
        [threads, chatCandidates, currentThreadId],
    );

    // Project rows first (files, then chats), then the other files and chats. The keyboard index runs through them in this order.
    const sections = useMemo((): MentionSection[] => {
        const files = partitionByProject(filteredFiles, (file) => file.chatId !== undefined && inProject.has(file.chatId));
        const chats = partitionByProject(chatCandidates.chats, (chat) => inProject.has(chat.id));
        const shownChats = chats.inProject.slice(0, MAX_CHAT_SUGGESTIONS);
        const fileRow = (file: VaultFileRef): MentionRow => {
            return { file, kind: "file" };
        };
        const chatRow = (chat: ChatReference): MentionRow => {
            return { chat, kind: "chat" };
        };

        return [
            { key: "project", label: t`In this project`, rows: [...files.inProject.map((file) => fileRow(file)), ...shownChats.map((chat) => chatRow(chat))] },
            { key: "files", label: t`Vault files`, rows: files.rest.map((file) => fileRow(file)) },
            { key: "chats", label: t`Chats`, rows: chats.rest.slice(0, Math.max(0, MAX_CHAT_SUGGESTIONS - shownChats.length)).map((chat) => chatRow(chat)) },
        ].filter((section) => section.rows.length > 0);
    }, [filteredFiles, chatCandidates, inProject, t]);
    const rows = useMemo(() => sections.flatMap((section) => section.rows), [sections]);

    // Total items: participants + 1 for "Upload new file" + files and chats
    const totalItems = participantCount + rows.length + 1;

    // Reset the highlighted row whenever the list length changes, and clear the search once the
    // popup closes. Adjusting during render (rather than in an effect) avoids painting a frame
    // with the stale selection. See https://react.dev/learn/you-might-not-need-an-effect
    const [renderedItemCount, setRenderedItemCount] = useState(totalItems);

    if (renderedItemCount !== totalItems) {
        setRenderedItemCount(totalItems);
        setSelectedIndex(0);
    }

    if (!match && (searchQuery !== "" || searchEdited)) {
        setSearchQuery("");
        setSearchEdited(false);
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
            } else {
                const row = rows[selectedIndex - participantCount - 1];

                if (row?.kind === "file") {
                    handleSelectFile(row.file);
                } else if (row) {
                    handleSelectChat(row.chat);
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
                    POPUP_ENTER_MOTION,
                )}
                style={{ width: MENU_WIDTH }}
            >
                {/* Filtering happens above (per list, on the title and the server search); the Command's own filter would hide a chat
                    matched by its summary while the keyboard index still counted it. */}
                <Command filter={null}>
                    <CommandInput
                        onChange={(e) => {
                            setSearchEdited(true);
                            setSearchQuery(e.target.value);
                        }}
                        placeholder={t`Search files and chats...`}
                        value={searchQuery}
                    />
                    <CommandList className="max-h-[300px]">
                        {/* Group chat participants - first, when the thread has them */}
                        {participantCount > 0 && (
                            <>
                                <CommandGroup>
                                    <CommandGroupLabel>{t`Participants`}</CommandGroupLabel>
                                    {filteredParticipants.map((participant, index) => (
                                        <CommandItem
                                            aria-selected={index === selectedIndex}
                                            className={clsx(POPUP_ROW_MOTION, index === selectedIndex && "bg-accent text-accent-foreground")}
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
                                aria-selected={selectedIndex === participantCount}
                                className={clsx(POPUP_ROW_MOTION, selectedIndex === participantCount && "bg-accent text-accent-foreground")}
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

                        {sections.map((section, sectionIndex) => {
                            const offset = participantCount + 1 + sections.slice(0, sectionIndex).reduce((count, previous) => count + previous.rows.length, 0);

                            return (
                                <Fragment key={section.key}>
                                    <CommandSeparator />
                                    <CommandGroup>
                                        <CommandGroupLabel>{section.label}</CommandGroupLabel>
                                        {section.rows.map((row, index) => {
                                            const selected = offset + index === selectedIndex;

                                            return (
                                                <CommandItem
                                                    aria-selected={selected}
                                                    className={clsx(POPUP_ROW_MOTION, selected && "bg-accent text-accent-foreground")}
                                                    key={row.kind === "file" ? row.file._id : row.chat.id}
                                                    onClick={(e) => {
                                                        e.preventDefault();

                                                        if (row.kind === "file") {
                                                            handleSelectFile(row.file);
                                                        } else {
                                                            handleSelectChat(row.chat);
                                                        }
                                                    }}
                                                    // A chat's title is in the value so the popup's own search matches it; the id keeps it unique.
                                                    value={row.kind === "file" ? row.file._id : `${row.chat.title} chat:${row.chat.id}`}
                                                >
                                                    {row.kind === "file" ? <FileRow file={row.file} /> : <ChatRow chat={row.chat} />}
                                                </CommandItem>
                                            );
                                        })}
                                    </CommandGroup>
                                </Fragment>
                            );
                        })}

                        {rows.length === 0 && activeQuery && (
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
