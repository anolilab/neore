import { useLingui } from "@lingui/react/macro";
import { Loader2, Send, Zap } from "lucide-react";
import type { KeyboardEvent } from "react";
import { memo, useCallback, useEffect, useRef, useState } from "react";

import cn from "../utils/cn";

interface ComposerProps {
    className?: string;
    disabled?: boolean;

    /**
     * Text to load into the composer from outside (a quick prompt, a restored
     * draft). Applied whenever `id` changes, so the same text can be loaded
     * twice; the textarea is focused afterwards.
     */
    draft?: { id: number; text: string };
    isStreaming?: boolean;
    onAutoContinueChange?: (enabled: boolean) => void;
    onSend: (text: string, options?: { shouldAutoContinue?: boolean }) => void;
    placeholder?: string;
    shouldAutoContinue?: boolean;
    showAutoContinue?: boolean;
}

const Composer = memo(
    ({
        className,
        disabled = false,
        draft,
        isStreaming = false,
        onAutoContinueChange,
        onSend,
        placeholder,
        shouldAutoContinue = false,
        showAutoContinue = false,
    }: ComposerProps) => {
        const { t } = useLingui();
        const [text, setText] = useState("");
        const textareaRef = useRef<HTMLTextAreaElement>(null);

        const isDisabled = disabled || isStreaming;
        const canSend = text.trim().length > 0 && !isDisabled;

        // Auto-resize textarea
        const adjustHeight = useCallback(() => {
            const element = textareaRef.current;

            if (!element) {
                return;
            }

            element.style.height = "auto";

            const maxHeight = 200;
            const newHeight = Math.min(element.scrollHeight, maxHeight);

            element.style.height = `${newHeight}px`;
        }, []);

        useEffect(() => {
            adjustHeight();
        }, [text, adjustHeight]);

        // Load a new `draft` during render (React's "adjust state on prop change"
        // pattern) rather than in an effect, so the text never renders stale.
        const [appliedDraftId, setAppliedDraftId] = useState<number | undefined>(undefined);

        if (draft && draft.id !== appliedDraftId) {
            setAppliedDraftId(draft.id);
            setText(draft.text);
        }

        const draftId = draft?.id;

        useEffect(() => {
            if (draftId !== undefined) {
                textareaRef.current?.focus();
            }
        }, [draftId]);

        const handleSend = () => {
            const trimmed = text.trim();

            if (!trimmed || isDisabled) {
                return;
            }

            onSend(trimmed, { shouldAutoContinue });
            setText("");

            // Reset height after clearing
            requestAnimationFrame(() => {
                if (textareaRef.current) {
                    textareaRef.current.style.height = "auto";
                }
            });
        };

        const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
            if (event.key !== "Enter" || event.shiftKey) {
                return;
            }

            event.preventDefault();
            handleSend();
        };

        return (
            <div className={cn("w-full px-3 py-3", className)}>
                {/* Auto-continue toolbar */}
                {showAutoContinue && (
                    <div className="mb-2 flex items-center gap-2">
                        <button
                            aria-label={shouldAutoContinue ? t`Disable deep work mode` : t`Enable deep work mode`}
                            aria-pressed={shouldAutoContinue}
                            className={cn(
                                "flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium transition-colors",
                                "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none",
                                shouldAutoContinue
                                    ? "bg-amber-100 text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/50"
                                    : "bg-gray-100 text-gray-500 hover:bg-gray-200 hover:text-gray-700 dark:bg-gray-800 dark:text-gray-400 dark:hover:bg-gray-700 dark:hover:text-gray-300",
                            )}
                            disabled={isDisabled}
                            onClick={() => onAutoContinueChange?.(!shouldAutoContinue)}
                            type="button"
                        >
                            <Zap aria-hidden="true" className={cn("size-3.5", shouldAutoContinue && "fill-current")} />
                            {t`Deep Work`}
                        </button>
                        {shouldAutoContinue && <span className="text-[11px] text-amber-600 dark:text-amber-400/80">{t`Up to 25 iterations`}</span>}
                    </div>
                )}

                <div
                    className={cn(
                        "flex items-end gap-2 rounded-2xl border bg-white px-3 py-2",
                        "border-gray-200 dark:border-gray-700 dark:bg-gray-900",
                        "focus-within:border-blue-400 focus-within:ring-2 focus-within:ring-blue-400/20",
                        "transition-all",
                    )}
                >
                    <textarea
                        aria-label={t`Message input`}
                        className={cn(
                            "flex-1 resize-none bg-transparent text-sm text-gray-900 dark:text-gray-50",
                            "placeholder:text-gray-400 dark:placeholder:text-gray-500",
                            "focus:outline-none",
                            "max-h-[200px] min-h-[36px]",
                            "scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600",
                            "disabled:cursor-not-allowed disabled:opacity-50",
                            "py-1 leading-6",
                        )}
                        disabled={isDisabled}
                        onChange={(event) => setText(event.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={placeholder ?? t`Message...`}
                        ref={textareaRef}
                        rows={1}
                        value={text}
                    />

                    <button
                        aria-label={isStreaming ? t`Generating response` : t`Send message`}
                        className={cn(
                            "flex size-8 shrink-0 items-center justify-center rounded-xl transition-colors",
                            canSend
                                ? "bg-blue-600 text-white hover:bg-blue-700 active:bg-blue-800"
                                : "bg-gray-100 text-gray-400 dark:bg-gray-800 dark:text-gray-600",
                            "focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 focus-visible:outline-none",
                            "disabled:cursor-not-allowed",
                        )}
                        disabled={!canSend}
                        onClick={handleSend}
                        type="button"
                    >
                        {isStreaming ? <Loader2 aria-hidden="true" className="size-4 animate-spin" /> : <Send aria-hidden="true" className="size-4" />}
                    </button>
                </div>

                <p className="mt-1.5 text-center text-[11px] text-gray-400 dark:text-gray-500">{t`Press Enter to send, Shift+Enter for new line`}</p>
            </div>
        );
    },
);

export default Composer;
