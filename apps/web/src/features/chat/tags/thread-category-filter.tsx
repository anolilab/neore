import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Badge } from "@neore/ui/components/badge";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { ChevronDown, Layers } from "lucide-react";
import type { FC } from "react";

import { THREAD_CATEGORY_LABELS } from "@/features/chat/tags/thread-categories";

/**
 * All thread categories that the AI can assign.
 */
const CATEGORIES: ReadonlyArray<{ id: string; label: MessageDescriptor }> = [
    { id: "all", label: msg`All` },
    { id: "coding", label: msg`Coding` },
    { id: "writing", label: msg`Writing` },
    { id: "research", label: msg`Research` },
    { id: "analysis", label: msg`Analysis` },
    { id: "brainstorming", label: msg`Brainstorming` },
    { id: "math", label: msg`Math` },
    { id: "learning", label: msg`Learning` },
    { id: "business", label: msg`Business` },
    { id: "creative", label: msg`Creative` },
    { id: "general", label: msg`General` },
];

interface ThreadCategoryFilterProperties {
    onCategoryChange: (category?: string) => void;
    selectedCategory?: string;
}

const ThreadCategoryFilter: FC<ThreadCategoryFilterProperties> = ({ onCategoryChange, selectedCategory }) => {
    const { i18n, t } = useLingui();
    const selectedLabel = selectedCategory ? THREAD_CATEGORY_LABELS[selectedCategory] : undefined;

    return (
        <DropdownMenu>
            <DropdownMenuTrigger
                render={
                    <Button
                        className="flex items-center gap-1 border-white/20 text-xs text-white hover:bg-white/10 data-[active]:bg-white/20"
                        size="sm"
                        variant="outline"
                    >
                        <Layers className="h-3 w-3" />
                        {selectedCategory ? (
                            <Badge className="text-xs" variant="secondary">
                                {selectedLabel ? i18n._(selectedLabel) : selectedCategory}
                            </Badge>
                        ) : (
                            t`All Categories`
                        )}
                        <ChevronDown className="h-3 w-3" />
                    </Button>
                }
            />
            <DropdownMenuContent className="w-48">
                {CATEGORIES.map((cat) => (
                    <DropdownMenuItem
                        className="flex items-center justify-between"
                        key={cat.id}
                        onClick={() => {
                            if (cat.id === "all") {
                                onCategoryChange(undefined);
                            } else {
                                onCategoryChange(cat.id);
                            }
                        }}
                    >
                        <span>{i18n._(cat.label)}</span>
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
};

export default ThreadCategoryFilter;
