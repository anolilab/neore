import { useLingui } from "@lingui/react/macro";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KeyboardEvent } from "react";
import { useId, useRef, useState } from "react";

import useDebouncedValue from "@/hooks/use-debounced-value";
import { useCRPC } from "@/lib/lunora/crpc";

const SEARCH_DEBOUNCE_MS = 200;
/** The keys the search answers itself; they do not also reach a global shortcut. */
const SEARCH_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape"]);

export interface ComposerPromptSearchProps {
    onClose: () => void;
    /** The chosen prompt's text. The caller puts it in the composer as a draft; nothing is sent. */
    onPick: (prompt: string) => void;
}

/**
 * Ctrl+R in the composer: searches the prompts the person has sent, across their threads, newest first. Arrow keys pick a
 * row, Enter fills the composer with it (`composer-input.tsx`), Escape closes. Each keystroke is a one-shot read: the
 * search is never live, and it is paused until something is typed.
 */
const ComposerPromptSearch = ({ onClose, onPick }: ComposerPromptSearchProps) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const queryClient = useQueryClient();
    const inputId = useId();
    const listId = useId();
    const listRef = useRef<HTMLDivElement>(null);
    const pickingRef = useRef(false);
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    // Set when a pick is refused or could not be checked; cleared by the next keystroke.
    const [pickNotice, setPickNotice] = useState<"gone" | "failed" | null>(null);
    const searched = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
    const { data, isError, isFetching } = useQuery(
        crpc.chat.functions.searchSentPrompts.queryOptions(searched === "" ? skipToken : { searchQuery: searched }, { live: false }),
    );
    const prompts = data?.prompts ?? [];
    // Typing or a new answer can leave the highlight past the end of the list; clamp it rather than reset it in an effect.
    const index = Math.min(active, Math.max(prompts.length - 1, 0));
    const optionId = (position: number) => `${listId}-${position}`;
    // Focus stays in the input; the list scrolls so the highlighted row is the one the arrow keys reach on screen.
    const moveActive = (position: number) => {
        setActive(position);
        listRef.current?.children.item(position)?.scrollIntoView({ block: "nearest" });
    };

    // The list on screen is one search old: a thread locked since then drops its prompts from a new search. So a pick runs
    // the same search again first, and a prompt that is no longer in it is not put in the composer.
    const pick = async (prompt: { messageId: string; text: string }) => {
        if (searched === "" || pickingRef.current) {
            return;
        }

        pickingRef.current = true;

        const options = crpc.chat.functions.searchSentPrompts.queryOptions({ searchQuery: searched }, { live: false });

        try {
            const fresh = await queryClient.fetchQuery({ ...options, staleTime: 0 });

            if (fresh.prompts.some((item) => item.messageId === prompt.messageId)) {
                onPick(prompt.text);
            } else {
                queryClient.setQueryData(options.queryKey, fresh);
                setPickNotice("gone");
            }
        } catch {
            setPickNotice("failed");
        }

        pickingRef.current = false;
    };

    const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
        if (event.nativeEvent.isComposing) {
            return;
        }

        // A key the search handles stops here: a global shortcut on the same key (Escape blurs the focused input) must not
        // run as well. The dialog's own dismissal listens on the document, which this key no longer reaches, so Escape closes here.
        if (SEARCH_KEYS.has(event.key)) {
            event.stopPropagation();
        }

        switch (event.key) {
            case "ArrowDown": {
                event.preventDefault();
                moveActive(Math.min(index + 1, Math.max(prompts.length - 1, 0)));
                break;
            }
            case "ArrowUp": {
                event.preventDefault();
                moveActive(Math.max(index - 1, 0));
                break;
            }
            case "Enter": {
                const picked = prompts[index];

                if (picked) {
                    event.preventDefault();
                    pick(picked);
                }

                break;
            }
            case "Escape": {
                event.preventDefault();
                onClose();
                break;
            }
            default: {
                break;
            }
        }
    };

    let status = t`Type to search the prompts you have sent.`;

    if (pickNotice === "gone") {
        status = t`That prompt is no longer available. Pick another.`;
    } else if (pickNotice === "failed") {
        status = t`The prompt could not be checked. Try again.`;
    } else if (searched !== "") {
        if (isError) {
            status = t`The search failed. Try again.`;
        } else if (isFetching && prompts.length === 0) {
            status = t`Searching`;
        } else if (prompts.length === 0) {
            status = t`No sent prompts match "${searched}".`;
        } else {
            status = t`${prompts.length} prompts found`;
        }
    }

    return (
        <Dialog
            onOpenChange={(open) => {
                if (!open) {
                    onClose();
                }
            }}
            open
        >
            <DialogContent className="max-w-lg" data-testid="composer-prompt-search">
                <DialogHeader>
                    <DialogTitle>{t`Search sent prompts`}</DialogTitle>
                    <DialogDescription>{t`Enter puts the prompt in the composer. It is not sent.`}</DialogDescription>
                </DialogHeader>
                <label className="sr-only" htmlFor={inputId}>
                    {t`Search sent prompts`}
                </label>
                <Input
                    aria-activedescendant={prompts.length > 0 ? optionId(index) : undefined}
                    aria-controls={listId}
                    aria-expanded={prompts.length > 0}
                    autoComplete="off"
                    id={inputId}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActive(0);
                        setPickNotice(null);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t`Search sent prompts`}
                    role="combobox"
                    type="search"
                    value={query}
                />
                <div aria-label={t`Matching prompts`} className="mt-3 max-h-80 space-y-1 overflow-y-auto" id={listId} ref={listRef} role="listbox">
                    {prompts.map((prompt, position) => (
                        <button
                            aria-selected={position === index}
                            className={`flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left text-sm ${
                                position === index ? "bg-muted" : "hover:bg-muted/60"
                            }`}
                            id={optionId(position)}
                            key={prompt.messageId}
                            onClick={() => pick(prompt)}
                            role="option"
                            tabIndex={-1}
                            type="button"
                        >
                            <span className="line-clamp-2 break-words">{prompt.text}</span>
                            <span className="text-muted-foreground text-xs">{prompt.threadTitle}</span>
                        </button>
                    ))}
                </div>
                <p aria-live="polite" className="text-muted-foreground mt-2 text-xs" role="status">
                    {status}
                </p>
                {data?.truncated === true && (
                    <p className="text-muted-foreground mt-1 text-xs">
                        {t`Only the best matches are searched, so an older or newer prompt may not be listed. Add a word to narrow the search.`}
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
};

export default ComposerPromptSearch;
