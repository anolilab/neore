import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { ArrowLeft, Loader2, Search, X } from "lucide-react";
import type { FC } from "react";
import { useEffect, useRef } from "react";

interface SearchBarProperties {
    isSearchLoading: boolean;
    /** Closes the search. The button for it carries `data-search-toggle`, so the Focus Search shortcut and a deleted row's focus handoff still find a toggle. */
    onClose: () => void;
    onSearchQueryChange: (query: string) => void;
    searchQuery: string;
    searchType: "threads" | "messages";
}

/** The dock's search field while the search is open: the input, a button that closes it, and a clear button once something is typed. */
const SearchBar: FC<SearchBarProperties> = ({ isSearchLoading, onClose, onSearchQueryChange, searchQuery, searchType }) => {
    const { t } = useLingui();
    const inputReference = useRef<HTMLInputElement>(null);

    // The field takes focus as it opens: it opens because the person asked for it, from the toggle or the shortcut.
    useEffect(() => {
        inputReference.current?.focus();
    }, []);

    return (
        <div className="relative flex h-[34px] min-w-0 flex-1 items-center">
            <Button
                aria-expanded
                aria-label={t`Close search`}
                className="text-muted-foreground hover:text-foreground absolute left-0.5 size-7 p-0"
                data-search-toggle=""
                onClick={onClose}
                size="icon-sm"
                variant="ghost"
            >
                <ArrowLeft aria-hidden="true" className="size-4" />
            </Button>
            <Search aria-hidden="true" className="text-muted-foreground pointer-events-none absolute left-9 size-3.5" />
            <input
                aria-label={searchType === "threads" ? t`Search thread titles and summaries` : t`Search message content`}
                className="text-foreground placeholder:text-muted-foreground focus-visible:ring-ring h-full w-full min-w-0 rounded-[10px] bg-transparent pr-14 pl-14 text-[13.5px] focus-visible:ring-2 focus-visible:outline-none"
                data-search-input=""
                onChange={(e) => {
                    onSearchQueryChange(e.target.value);
                }}
                placeholder={searchType === "threads" ? t`Search thread titles...` : t`Search message content...`}
                ref={inputReference}
                value={searchQuery}
            />
            {isSearchLoading && (
                <div className="absolute top-1/2 right-8 -translate-y-1/2">
                    <Loader2 className="text-muted-foreground size-3 animate-spin" />
                </div>
            )}
            {searchQuery && (
                <Button
                    aria-label={t`Clear search`}
                    className="absolute top-1/2 right-1 size-6 -translate-y-1/2 p-0"
                    onClick={() => {
                        onSearchQueryChange("");
                    }}
                    size="icon"
                    variant="ghost"
                >
                    <X aria-hidden="true" className="size-3" />
                </Button>
            )}
        </div>
    );
};

export default SearchBar;
