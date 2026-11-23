import { plural } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { DraftFrom } from "@neore/backend/not-typed-text";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@neore/ui/components/dialog";
import { Input } from "@neore/ui/components/input";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { KeyboardEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";

import useDebouncedValue from "@/hooks/use-debounced-value";
import { useCRPC } from "@/lib/lunora/crpc";

const SEARCH_DEBOUNCE_MS = 200;
/** The server searches the first 500 characters (`searchSentPrompts`); a longer paste is cut here, not refused there. */
const SEARCH_MAX_LENGTH = 500;
/** The keys the search answers itself; they do not also reach a global shortcut. */
const SEARCH_KEYS = new Set(["ArrowDown", "ArrowUp", "Enter", "Escape"]);

type PickOutcome<T> = { kind: "failed" } | { fresh: T | undefined; kind: "gone" } | { kind: "found" };

/**
 * Asks the server whether the picked prompt may still go in the draft, and on a refusal runs the search again for the list.
 * The check reads that one prompt: the search lists at most 50, so newer matches can push a prompt out of it while it is
 * still available. Outside the component: the React Compiler skips a component with a conditional inside a `catch`.
 */
const recheckPick = async <T,>(check: () => Promise<boolean>, search: () => Promise<T>): Promise<PickOutcome<T>> => {
    let available: boolean;

    try {
        available = await check();
    } catch {
        return { kind: "failed" };
    }

    if (available) {
        return { kind: "found" };
    }

    // The refusal stands without a fresh list: the notice says so, and the old list stays until the next keystroke.
    try {
        return { fresh: await search(), kind: "gone" };
    } catch {
        return { fresh: undefined, kind: "gone" };
    }
};

export interface PickedPrompt {
    /** Set when the prompt was saved as not typed by the person (`@neore/backend/not-typed-text`), so it goes out marked again. */
    draftFrom?: DraftFrom;
    text: string;
}

export interface ComposerPromptSearchProps {
    onClose: () => void;
    /** The chosen prompt and its not-typed mark. The caller puts it in the composer as a draft; nothing is sent. */
    onPick: (prompt: PickedPrompt) => void;
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
    // The arrow keys are read only by the input: a refused click hands focus back to it.
    const inputRef = useRef<HTMLInputElement>(null);
    const pickingRef = useRef(false);
    // A pick still checking when the search closes is dropped: the composer it was meant for may be locked or showing another chat.
    const mountedRef = useRef(true);
    // The query as typed, kept for a pick's check: one that finishes after the person typed again belongs to the old search.
    const queryRef = useRef("");
    const [query, setQuery] = useState("");
    const [active, setActive] = useState(0);
    // Set when a pick is refused or could not be checked; cleared by the next keystroke.
    const [pickNotice, setPickNotice] = useState<"gone" | "failed" | null>(null);
    const searched = useDebouncedValue(query.trim(), SEARCH_DEBOUNCE_MS);
    // While the debounce runs, the list is the previous search's: it stays on screen, but nothing in it can be picked.
    const settled = query.trim() === searched;
    // Read fresh on every open, and dropped once the search closes: prompts are private text, and a cached answer would outlive
    // a sent prompt, a deleted chat or a switch to another account.
    const { data, isError, isFetching } = useQuery({
        ...crpc.chat.functions.searchSentPrompts.queryOptions(searched === "" ? skipToken : { searchQuery: searched }, { live: false }),
        gcTime: 0,
        staleTime: 0,
    });

    useEffect(() => {
        mountedRef.current = true;

        return () => {
            mountedRef.current = false;
        };
    }, []);

    const prompts = data?.prompts ?? [];
    // Typing or a new answer can leave the highlight past the end of the list; clamp it rather than reset it in an effect.
    const index = Math.min(active, Math.max(prompts.length - 1, 0));
    const optionId = (position: number) => `${listId}-${position}`;
    // Focus stays in the input; the list scrolls so the highlighted row is the one the arrow keys reach on screen.
    const moveActive = (position: number) => {
        setActive(position);
        listRef.current?.children.item(position)?.scrollIntoView({ block: "nearest" });
    };

    // The list on screen is one search old: a thread locked, trashed or made temporary since then no longer lists. So a pick
    // asks the server about that prompt first, and one no longer available is not put in the composer.
    const pick = async (prompt: (typeof prompts)[number]) => {
        if (searched === "" || !settled || pickingRef.current) {
            // A click focuses its row; the arrow keys work only from the input.
            inputRef.current?.focus();

            return;
        }

        pickingRef.current = true;

        const options = crpc.chat.functions.searchSentPrompts.queryOptions({ searchQuery: searched }, { live: false });
        const checkOptions = crpc.chat.functions.isSentPromptAvailable.queryOptions({ messageId: prompt.messageId }, { live: false });
        const outcome = await recheckPick(
            () => queryClient.fetchQuery({ ...checkOptions, gcTime: 0, staleTime: 0 }),
            () => queryClient.fetchQuery({ ...options, gcTime: 0, staleTime: 0 }),
        );

        pickingRef.current = false;

        // Closed, or the search changed, while the check ran: nothing goes in the draft and no notice covers the new list.
        if (!mountedRef.current || queryRef.current.trim() !== searched) {
            return;
        }

        if (outcome.kind === "found") {
            onPick({ ...(prompt.draftFrom !== undefined && { draftFrom: prompt.draftFrom }), text: prompt.text });

            return;
        }

        if (outcome.kind === "gone") {
            if (outcome.fresh !== undefined) {
                queryClient.setQueryData(options.queryKey, outcome.fresh);
            }

            setPickNotice("gone");
        } else {
            setPickNotice("failed");
        }

        // A clicked row took focus, and a refused one may have left the list with it.
        inputRef.current?.focus();
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

        // Ctrl+R again steps to the next match, as a shell's reverse search does, and never reaches the browser's reload.
        if (event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "r") {
            event.preventDefault();
            event.stopPropagation();
            moveActive(Math.min(index + 1, Math.max(prompts.length - 1, 0)));

            return;
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
            // Inside `t`: a bare `plural()` compiles to the global i18n, which this app never activates.
            // eslint-disable-next-line no-restricted-syntax -- the macro compiles this to a message, not a string conversion
            status = t`${plural(prompts.length, { one: "# prompt found", other: "# prompts found" })}`;
        }
    }

    // Inside the status, so a screen reader hears that the list may be incomplete along with the count.
    const truncatedNotice =
        searched !== "" && pickNotice === null && data?.truncated === true
            ? t`Only the best matches are searched, so an older or newer prompt may not be listed. Add a word to narrow the search.`
            : undefined;

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
                    aria-autocomplete="list"
                    aria-controls={listId}
                    aria-expanded={prompts.length > 0}
                    autoComplete="off"
                    id={inputId}
                    maxLength={SEARCH_MAX_LENGTH}
                    onChange={(event) => {
                        queryRef.current = event.target.value;
                        setQuery(event.target.value);
                        setActive(0);
                        setPickNotice(null);
                    }}
                    onKeyDown={onKeyDown}
                    placeholder={t`Search sent prompts`}
                    ref={inputRef}
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
                <div aria-live="polite" className="text-muted-foreground mt-2 space-y-1 text-xs" role="status">
                    <p>{status}</p>
                    {truncatedNotice !== undefined && <p>{truncatedNotice}</p>}
                </div>
            </DialogContent>
        </Dialog>
    );
};

export default ComposerPromptSearch;
