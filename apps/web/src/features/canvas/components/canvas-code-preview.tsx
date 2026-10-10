/**
 * Live preview for HTML/SVG/React code artifacts: the sandboxed preview shell in an
 * iframe, plus a collapsible panel for errors the in-frame console bridge
 * reports. See `lib/preview-shell.ts` for the isolation model and
 * `lib/preview-srcdoc.ts` for the CSP.
 */

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import { ExternalLinkIcon, RotateCwIcon } from "lucide-react";
import type { FC } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";

import type { PreviewShellRenderMessage } from "../lib/preview-shell";
import { ARTIFACT_PREVIEW_PATH, encodePreviewFragment, isPreviewShellReadyMessage, isPreviewShellRenderedMessage } from "../lib/preview-shell";
import type { PreviewLanguage, PreviewMessage } from "../lib/preview-srcdoc";
import { buildPreviewSrcdoc, isPreviewMessage, PREVIEW_MESSAGE_SOURCE } from "../lib/preview-srcdoc";
import { createViolationDeduper } from "../lib/preview-violation-dedupe";

/** Re-render cadence while the artifact streams in, so the frame is not rebuilt per token. */
const STREAMING_DEBOUNCE_MS = 600;
/** Cadence for settled content (edits, version switches). */
const IDLE_DEBOUNCE_MS = 150;
/** The frame can log in a loop; keep only the most recent entries. */
const MAX_MESSAGES = 50;
/** Swap a pending frame in even if it never reports `rendered` (e.g. the artifact clobbered `parent`). */
const SWAP_FALLBACK_MS = 2000;

type ConsoleEntry = PreviewMessage & { id: number };

/** One shell load. The shell renders once, so every new document is a new slot. */
interface FrameSlot {
    html: string;
    key: number;
}

interface CanvasCodePreviewProps {
    content: string;
    isStreaming?: boolean;
    language: PreviewLanguage;
    title: string;
}

const CanvasCodePreview: FC<CanvasCodePreviewProps> = memo(({ content, isStreaming, language, title }) => {
    const { t } = useLingui();
    // Double-buffered: `active` stays visible while `pending` loads hidden
    // behind it, and is replaced only once the pending shell has rendered.
    const [active, setActive] = useState<FrameSlot>(() => {
        return { html: buildPreviewSrcdoc(content, language), key: 0 };
    });
    const [pending, setPending] = useState<FrameSlot | undefined>(undefined);
    const [messages, setMessages] = useState<ConsoleEntry[]>([]);
    const nextKeyRef = useRef(1);
    const nextMessageIdRef = useRef(0);
    const framesRef = useRef(new Map<number, HTMLIFrameElement>());
    // One blocked request is reported once per policy (shell + artifact); keep one.
    const isDuplicateViolationRef = useRef(createViolationDeduper());
    const slotsRef = useRef({ active, pending });

    useEffect(() => {
        slotsRef.current = { active, pending };
    }, [active, pending]);

    const promotePending = useCallback((key: number) => {
        const current = slotsRef.current.pending;

        if (current?.key === key) {
            setActive(current);
            setPending(undefined);
        }
    }, []);

    const queueRender = useCallback((html: string) => {
        const key = nextKeyRef.current;

        nextKeyRef.current += 1;
        setPending({ html, key });
        // A fresh document means the old errors no longer describe anything on screen.
        setMessages([]);
        isDuplicateViolationRef.current = createViolationDeduper();
    }, []);

    // A half-streamed component does not compile, so a React preview holds its
    // last render until the stream ends instead of flashing transpile errors.
    const holdWhileStreaming = Boolean(isStreaming) && language === "react";

    useEffect(() => {
        if (holdWhileStreaming) {
            return undefined;
        }

        const timer = setTimeout(
            () => {
                const html = buildPreviewSrcdoc(content, language);
                const newest = slotsRef.current.pending ?? slotsRef.current.active;

                if (html !== newest.html) {
                    queueRender(html);
                }
            },
            isStreaming ? STREAMING_DEBOUNCE_MS : IDLE_DEBOUNCE_MS,
        );

        return () => {
            clearTimeout(timer);
        };
    }, [content, holdWhileStreaming, isStreaming, language, queueRender]);

    useEffect(() => {
        if (!pending) {
            return undefined;
        }

        const timer = setTimeout(promotePending, SWAP_FALLBACK_MS, pending.key);

        return () => {
            clearTimeout(timer);
        };
    }, [pending, promotePending]);

    useEffect(() => {
        const handleMessage = (event: MessageEvent) => {
            // Only our own preview frames are trusted; their origin is opaque
            // ("null"), so the source window is the only thing to check.
            let sourceKey: number | undefined;

            for (const [key, frame] of framesRef.current) {
                if (frame.contentWindow && event.source === frame.contentWindow) {
                    sourceKey = key;
                }
            }

            if (sourceKey === undefined) {
                return;
            }

            const { active: currentActive, pending: currentPending } = slotsRef.current;
            const slot = [currentPending, currentActive].find((candidate) => candidate?.key === sourceKey);

            if (!slot) {
                return;
            }

            if (isPreviewShellReadyMessage(event.data)) {
                const render: PreviewShellRenderMessage = { html: slot.html, source: PREVIEW_MESSAGE_SOURCE, type: "render" };

                // "*" because an opaque origin cannot be named as a target.
                // The payload is the artifact itself, nothing the frame lacks.
                (event.source as Window).postMessage(render, "*");

                return;
            }

            if (isPreviewShellRenderedMessage(event.data)) {
                promotePending(sourceKey);

                return;
            }

            // Errors only from the newest document; the outgoing one's are stale.
            if (!isPreviewMessage(event.data) || sourceKey !== (currentPending ?? currentActive).key) {
                return;
            }

            if (isDuplicateViolationRef.current(event.data.message)) {
                return;
            }

            nextMessageIdRef.current += 1;

            const entry: ConsoleEntry = { ...event.data, id: nextMessageIdRef.current };

            setMessages((previous) => [...previous, entry].slice(-MAX_MESSAGES));
        };

        globalThis.addEventListener("message", handleMessage);

        return () => {
            globalThis.removeEventListener("message", handleMessage);
        };
    }, [promotePending]);

    const handleReload = useCallback(() => {
        queueRender((slotsRef.current.pending ?? slotsRef.current.active).html);
    }, [queueRender]);

    const handleOpenInNewTab = useCallback(() => {
        // Top-level, the shell is still opaque-origin: its response CSP carries
        // `sandbox allow-scripts`. The fragment never reaches the server.
        const { html } = slotsRef.current.pending ?? slotsRef.current.active;

        globalThis.open(`${ARTIFACT_PREVIEW_PATH}#${encodePreviewFragment(html)}`, "_blank", "noopener,noreferrer");
    }, []);

    const errorCount = messages.filter((message) => message.level === "error").length;
    const warningCount = messages.length - errorCount;
    const slots = pending ? [active, pending] : [active];

    let statusText = t`Live preview`;

    if (holdWhileStreaming) {
        statusText = t`Live preview — renders when the component finishes streaming`;
    } else if (isStreaming) {
        statusText = t`Live preview — updating as the artifact streams`;
    }

    return (
        <div className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-1">
                <span aria-live="polite" className="text-muted-foreground text-xs" role="status">
                    {statusText}
                </span>
                <div className="flex items-center gap-1">
                    <TooltipIconButton onClick={handleReload} tooltip={t`Reload preview`}>
                        <RotateCwIcon aria-hidden="true" className="size-4" />
                    </TooltipIconButton>
                    <TooltipIconButton onClick={handleOpenInNewTab} tooltip={t`Open preview in new tab`}>
                        <ExternalLinkIcon aria-hidden="true" className="size-4" />
                    </TooltipIconButton>
                </div>
            </div>
            <div className="relative min-h-0 flex-1">
                {/* Keyed list: when `pending` is promoted it keeps its key, so React
                    moves nothing and the loaded frame is not reloaded. */}
                {slots.map((slot) => {
                    const isVisible = slot.key === active.key;

                    return (
                        <iframe
                            aria-hidden={isVisible ? undefined : true}
                            className={cn("absolute inset-0 size-full border-0", language === "svg" ? "bg-background" : "bg-white", !isVisible && "invisible")}
                            key={slot.key}
                            ref={(element) => {
                                if (element) {
                                    framesRef.current.set(slot.key, element);
                                } else {
                                    framesRef.current.delete(slot.key);
                                }
                            }}
                            // allow-scripts WITHOUT allow-same-origin: the frame gets an opaque
                            // origin. Combining the two would let the artifact remove its own sandbox.
                            sandbox="allow-scripts"
                            src={ARTIFACT_PREVIEW_PATH}
                            tabIndex={isVisible ? undefined : -1}
                            title={t`Preview of ${title}`}
                        />
                    );
                })}
            </div>
            {messages.length > 0 && (
                <details className="max-h-48 shrink-0 overflow-auto border-t text-xs">
                    <summary className="text-destructive cursor-pointer px-3 py-1.5 font-medium">
                        <span aria-live="polite" role="status">
                            {t`Console: ${errorCount} errors, ${warningCount} warnings`}
                        </span>
                    </summary>
                    <ul className="divide-y font-mono">
                        {messages.map((message) => (
                            <li
                                className={cn(
                                    "px-3 py-1 break-words whitespace-pre-wrap",
                                    message.level === "error" ? "text-destructive" : "text-amber-600 dark:text-amber-400",
                                )}
                                key={message.id}
                            >
                                {message.message}
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
});

CanvasCodePreview.displayName = "CanvasCodePreview";

export default CanvasCodePreview;
