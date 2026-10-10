"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { code } from "@streamdown/code";
import { useMutation } from "@tanstack/react-query";
import clsx from "clsx";
import { ChevronDownIcon, LocateFixedIcon, PencilIcon, PinIcon, Trash2Icon } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Streamdown } from "streamdown";

import { scrollToMessage } from "@/features/chat/thread/message-list";
import { trackEvent } from "@/lib/analytics";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

// Only the edit dialog needs the editor, and `reactjs-tiptap-editor` brings
// KaTeX with it — a static import put both on every chat page.
const TiptapEditor = lazy(() =>
    import("@neore/ui/components/tiptap-editor").then((m) => {
        return { default: m.TiptapEditor };
    }),
);

const COLLAPSED_HEIGHT = 96;
const NOTE_DEBOUNCE_MS = 500;
const STREAMDOWN_PLUGINS = { code };
const STREAMDOWN_CONTROLS = { mermaid: false, table: false };

const relativeTime = (ts: number): MessageDescriptor => {
    const diff = Date.now() - ts;
    const minutes = Math.floor(diff / 60_000);

    if (minutes < 1) {
        return msg`just now`;
    }

    if (minutes < 60) return msg`${minutes}m ago`;

    const hours = Math.floor(minutes / 60);

    if (hours < 24) return msg`${hours}h ago`;

    const days = Math.floor(hours / 24);

    return msg`${days}d ago`;
};

interface PinItemProps {
    pin: {
        _id: string;
        createdAt: number;
        messageId: string;
        messageRole: string;
        note?: string;
        selectedText?: string;
    };
}

const PinItem: FC<PinItemProps> = ({ pin }) => {
    const { i18n, t } = useLingui();
    const crpc = useCRPC();
    const noteDebounceRef = useRef<ReturnType<typeof setTimeout>>(null);
    const contentRef = useRef<HTMLDivElement>(null);

    const [noteValue, setNoteValue] = useState(pin.note ?? "");
    const [isExpanded, setIsExpanded] = useState(false);
    const [needsExpand, setNeedsExpand] = useState(false);
    const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
    const [editTextValue, setEditTextValue] = useState("");

    const { mutate: updateNote } = useMutation(crpc.chat.pins.functions.updatePinNote.mutationOptions());
    const { mutate: updateSelectedText } = useMutation(crpc.chat.pins.functions.updatePinSelectedText.mutationOptions());
    const { mutate: deletePin } = useMutation(crpc.chat.pins.functions.deletePin.mutationOptions());

    useEffect(
        () => () => {
            if (noteDebounceRef.current) {
                clearTimeout(noteDebounceRef.current);
            }
        },
        [],
    );

    // Sync note value when switching to a different pin. Adjusted during render
    // rather than in an effect, so the textarea never paints the previous note.
    const [syncedPinId, setSyncedPinId] = useState(pin._id);

    if (pin._id !== syncedPinId) {
        setSyncedPinId(pin._id);
        setNoteValue(pin.note ?? "");
    }

    useEffect(() => {
        const element = contentRef.current;

        if (!element) {
            return undefined;
        }

        const check = () => setNeedsExpand(element.scrollHeight > COLLAPSED_HEIGHT);
        const observer = new ResizeObserver(check);

        observer.observe(element);
        check();

        return () => observer.disconnect();
    }, [pin.selectedText]);

    const handleNoteChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        const { value } = e.target;

        setNoteValue(value);

        if (noteDebounceRef.current) {
            clearTimeout(noteDebounceRef.current);
        }

        noteDebounceRef.current = setTimeout(() => {
            updateNote({ note: value, pinId: pin._id });
        }, NOTE_DEBOUNCE_MS);
    };

    const handleDelete = () =>
        deletePin(
            { pinId: pin._id },
            {
                onError: (e) => showError(e as Error),
                onSuccess: () => trackEvent("message_unpinned", {}),
            },
        );

    const handleOpenEditDialog = () => {
        setEditTextValue(pin.selectedText ?? "");
        setIsEditDialogOpen(true);
    };

    const handleEditTextChange = (value: string) => {
        setEditTextValue(value);
    };

    const handleSaveText = () => {
        const trimmed = editTextValue.trim();

        if (trimmed && trimmed !== pin.selectedText) {
            updateSelectedText({ pinId: pin._id, selectedText: trimmed }, { onError: (e) => showError(e as Error) });
        }

        setIsEditDialogOpen(false);
    };

    const handleCancelEdit = () => setIsEditDialogOpen(false);

    const isUser = pin.messageRole === "user";

    return (
        <>
            <div className="group/pin relative flex overflow-hidden rounded-md border">
                <div className="flex w-full flex-col px-3 pt-2.5 pb-2">
                    {!pin.selectedText && (
                        <div className="text-muted-foreground/60 mb-2 flex items-center gap-1.5 text-xs">
                            <PinIcon className="size-3" />
                            <span className="italic">{t`Full message pinned`}</span>
                        </div>
                    )}

                    {pin.selectedText && (
                        <div className="flex flex-1 flex-col items-center gap-2">
                            <div className="w-full overflow-auto">
                                <motion.div
                                    animate={{ height: needsExpand && !isExpanded ? COLLAPSED_HEIGHT : "auto" }}
                                    className={clsx(
                                        "text-foreground/75 mb-2 overflow-hidden text-xs leading-relaxed [&_pre]:text-[10px] [&_table]:w-full [&_table]:text-[10px]",
                                        !isExpanded && needsExpand && "[mask-image:linear-gradient(to_bottom,black_60%,transparent_100%)]",
                                    )}
                                    initial={false}
                                    ref={contentRef}
                                    transition={{ duration: 0.25, ease: "easeInOut" }}
                                >
                                    <Streamdown controls={STREAMDOWN_CONTROLS} plugins={STREAMDOWN_PLUGINS}>
                                        {pin.selectedText}
                                    </Streamdown>
                                </motion.div>
                                <div className="border-sidebar-border/30 mb-1.5 border-t" />
                            </div>

                            {(needsExpand || isExpanded) && (
                                <button
                                    className="text-muted-foreground/50 hover:text-muted-foreground mb-2 rounded p-0.5 transition-colors"
                                    onClick={() => setIsExpanded((v) => !v)}
                                    title={isExpanded ? t`Show less` : t`Show more`}
                                    type="button"
                                >
                                    <motion.span
                                        animate={{ rotate: isExpanded ? 180 : 0 }}
                                        className="inline-flex"
                                        initial={false}
                                        transition={{ duration: 0.2, ease: "easeInOut" }}
                                    >
                                        <ChevronDownIcon className="size-4" />
                                    </motion.span>
                                </button>
                            )}
                        </div>
                    )}

                    <textarea
                        className="text-foreground placeholder:text-muted-foreground/50 focus-visible:ring-ring/50 field-sizing-content w-full resize-none bg-transparent text-[11px] leading-relaxed outline-none placeholder:italic focus-visible:ring-1"
                        onChange={handleNoteChange}
                        placeholder={t`Add a note…`}
                        rows={1}
                        value={noteValue}
                    />

                    <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                            <span
                                className={clsx(
                                    "text-xs font-semibold tracking-widest uppercase",
                                    isUser ? "text-blue-500 dark:text-blue-400" : "text-amber-600 dark:text-amber-400",
                                )}
                            >
                                {isUser ? t`You` : t`AI`}
                            </span>
                            <span className="text-muted-foreground/40 text-xs">·</span>
                            <span className="text-muted-foreground/50 text-xs">{i18n._(relativeTime(pin.createdAt))}</span>
                        </div>

                        <div className="flex items-center gap-0.5">
                            <button
                                aria-label={t`Go to message`}
                                className="text-muted-foreground/50 hover:text-muted-foreground rounded p-0.5 transition-colors"
                                onClick={() => scrollToMessage(pin.messageId)}
                                title={t`Go to message`}
                                type="button"
                            >
                                <LocateFixedIcon aria-hidden="true" className="size-4" />
                            </button>
                            <button
                                className="text-muted-foreground/50 hover:text-muted-foreground rounded p-0.5 transition-colors"
                                onClick={handleOpenEditDialog}
                                title={t`Edit excerpt`}
                                type="button"
                            >
                                <PencilIcon className="size-4" />
                            </button>
                            <button
                                className="text-muted-foreground/50 hover:text-destructive rounded p-0.5 transition-colors"
                                onClick={handleDelete}
                                title={t`Delete pin`}
                                type="button"
                            >
                                <Trash2Icon className="size-4" />
                            </button>
                        </div>
                    </div>
                </div>
            </div>

            <Dialog onOpenChange={setIsEditDialogOpen} open={isEditDialogOpen}>
                <DialogContent className="max-w-2xl gap-0 p-0">
                    <DialogHeader className="border-b px-5 py-4">
                        <DialogTitle className="text-base">{pin.selectedText ? t`Edit excerpt` : t`Add excerpt`}</DialogTitle>
                    </DialogHeader>
                    <div className="h-96 overflow-hidden">
                        <Suspense fallback={null}>
                            <TiptapEditor
                                className="h-full border-0"
                                content={editTextValue}
                                editorClassName="h-full min-h-0"
                                locale={i18n.locale}
                                onChange={handleEditTextChange}
                            />
                        </Suspense>
                    </div>
                    <DialogFooter className="border-t px-5 py-3">
                        <Button onClick={handleCancelEdit} variant="outline">{t`Cancel`}</Button>
                        <Button onClick={handleSaveText}>{t`Save`}</Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </>
    );
};

PinItem.displayName = "PinItem";

export default PinItem;
