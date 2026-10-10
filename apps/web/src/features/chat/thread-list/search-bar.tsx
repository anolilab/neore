import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Loader2, X } from "lucide-react";
import type { FC } from "react";

import ThreadCategoryFilter from "@/features/chat/tags/thread-category-filter";
import ThreadTagFilter from "@/features/chat/tags/thread-tag-filter";

import { selectSelectedTagIds, selectSetSelectedTagIds, selectSetShowManageTagsDialog, useThreadListUIStore } from "./stores/thread-list-ui-store";

interface SearchBarProperties {
    isSearchLoading: boolean;
    onSearchQueryChange: (query: string) => void;
    onSearchTypeChange: (type: "threads" | "messages") => void;
    onSelectedCategoryChange: (category: string | undefined) => void;
    searchQuery: string;
    searchType: "threads" | "messages";
    selectedCategory?: string;
}

const SearchBar: FC<SearchBarProperties> = ({
    isSearchLoading,
    onSearchQueryChange,
    onSearchTypeChange,
    onSelectedCategoryChange,
    searchQuery,
    searchType,
    selectedCategory,
}) => {
    const { t } = useLingui();
    const selectedTagIds = useThreadListUIStore(selectSelectedTagIds);
    const setSelectedTagIds = useThreadListUIStore(selectSetSelectedTagIds);
    const setShowManageTagsDialog = useThreadListUIStore(selectSetShowManageTagsDialog);

    return (
        <div className="space-y-2">
            <div className="flex items-center gap-2">
                <Button
                    className="border-sidebar-border text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active]:bg-sidebar-accent data-[active]:text-sidebar-accent-foreground text-xs"
                    onClick={() => {
                        onSearchTypeChange("threads");
                    }}
                    size="sm"
                    variant={searchType === "threads" ? "default" : "outline"}
                >
                    {t`Threads`}
                </Button>
                <Button
                    className="border-sidebar-border text-brand-black dark:text-brand-white hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[active]:bg-sidebar-accent data-[active]:text-sidebar-accent-foreground text-xs"
                    onClick={() => {
                        onSearchTypeChange("messages");
                    }}
                    size="sm"
                    variant={searchType === "messages" ? "default" : "outline"}
                >
                    {t`Messages`}
                </Button>
                <ThreadCategoryFilter onCategoryChange={onSelectedCategoryChange} selectedCategory={selectedCategory} />
                <ThreadTagFilter
                    onManageTags={() => {
                        setShowManageTagsDialog(true);
                    }}
                    onSelectedTagIdsChange={setSelectedTagIds}
                    selectedTagIds={selectedTagIds}
                />
            </div>
            <div className="relative">
                <Input
                    autoFocus
                    className="border-sidebar-border bg-sidebar text-brand-black dark:text-brand-white placeholder:text-brand-black/60 placeholder:dark:text-brand-white/60 pr-8"
                    onChange={(e) => {
                        onSearchQueryChange(e.target.value);
                    }}
                    placeholder={searchType === "threads" ? t`Search thread titles...` : t`Search message content...`}
                    value={searchQuery}
                />
                {searchQuery && (
                    <Button
                        className="absolute top-1/2 right-1 h-6 w-6 -translate-y-1/2 p-0"
                        onClick={() => {
                            onSearchQueryChange("");
                        }}
                        size="icon"
                        variant="ghost"
                    >
                        <X className="h-3 w-3" />
                    </Button>
                )}
                {isSearchLoading && (
                    <div className="absolute top-1/2 right-8 -translate-y-1/2">
                        <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />
                    </div>
                )}
            </div>
        </div>
    );
};

export default SearchBar;
