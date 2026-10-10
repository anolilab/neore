import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@ui/components/responsive-popover";
import { ScrollArea } from "@ui/components/scroll-area";
import { Separator } from "@ui/components/separator";
import { Clock, History, Redo2, RotateCcw, Undo2 } from "lucide-react";
import { useEffect } from "react";

import type { HistoryEntry } from "../stores/history-store";
import { MAX_HISTORY_ENTRIES, useCanRedo, useCanUndo, useHistoryEntries, useHistoryStore } from "../stores/history-store";
import { useWorkflowStore } from "../stores/workflow-store";

/** `justNow` is the (translated) text for anything under a minute old. */
const formatTimestamp = (timestamp: number, locale: string, justNow: string): string => {
    const now = Date.now();
    const diff = now - timestamp;

    if (diff < 60_000) {
        return justNow;
    }

    const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });

    if (diff < 3_600_000) {
        return relative.format(-Math.floor(diff / 60_000), "minute");
    }

    if (diff < 86_400_000) {
        return relative.format(-Math.floor(diff / 3_600_000), "hour");
    }

    return new Date(timestamp).toLocaleString(locale);
};

interface HistoryEntryItemProps {
    entry: HistoryEntry;
    isCurrent: boolean;
    onRestore: (entry: HistoryEntry) => void;
}

const HistoryEntryItem = ({ entry, isCurrent, onRestore }: HistoryEntryItemProps) => {
    const nodeCount = entry.content.nodes.length;
    const edgeCount = entry.content.edges.length;
    const { i18n, t } = useLingui();

    return (
        <button
            className={`flex w-full items-start gap-3 rounded-lg p-3 text-left transition-colors ${
                isCurrent ? "bg-primary/10 border-primary border" : "hover:bg-accent"
            }`}
            onClick={() => onRestore(entry)}
            type="button"
        >
            <div className="mt-0.5 flex-shrink-0">
                <Clock className={`size-4 ${isCurrent ? "text-primary" : "text-muted-foreground"}`} />
            </div>
            <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${isCurrent ? "text-primary" : ""}`}>
                        {entry.label ?? (entry.isAutoSave ? t`Auto-save` : t`Manual save`)}
                    </span>
                    {isCurrent && (
                        <span className="bg-primary text-primary-foreground rounded px-1.5 py-0.5 text-xs">
                            <Trans>Current</Trans>
                        </span>
                    )}
                </div>
                <p className="text-muted-foreground mt-1 text-xs">{formatTimestamp(entry.timestamp, i18n.locale, t`Just now`)}</p>
                <p className="text-muted-foreground text-xs">
                    <Plural one="# node" other="# nodes" value={nodeCount} />, <Plural one="# edge" other="# edges" value={edgeCount} />
                </p>
            </div>
        </button>
    );
};

const VersionHistory = () => {
    const entries = useHistoryEntries();
    const canUndo = useCanUndo();
    const canRedo = useCanRedo();
    const { currentIndex, pushEntry, redo, restoreEntry, setNavigating, undo } = useHistoryStore();
    const { getContent, loadContent } = useWorkflowStore();
    const { t } = useLingui();

    // Create initial history entry on mount if empty
    useEffect(() => {
        if (entries.length > 0) {
            return;
        }

        const content = getContent();

        if (content.nodes.length > 0) {
            pushEntry(content, t`Initial state`);
        }
    }, [entries.length, getContent, pushEntry, t]);

    const handleUndo = () => {
        const entry = undo();

        if (entry) {
            loadContent(entry.content);
            // Allow new entries after a short delay
            setTimeout(setNavigating, 100, false);
        }
    };

    const handleRedo = () => {
        const entry = redo();

        if (entry) {
            loadContent(entry.content);
            setTimeout(setNavigating, 100, false);
        }
    };

    const handleRestore = (entry: HistoryEntry) => {
        const restoredEntry = restoreEntry(entry.id);

        if (restoredEntry) {
            loadContent(restoredEntry.content);
            setTimeout(setNavigating, 100, false);
        }
    };

    return (
        <div className="flex items-center gap-1">
            <Button aria-label={t`Undo (Ctrl+Z)`} disabled={!canUndo} onClick={handleUndo} size="icon" title={t`Undo (Ctrl+Z)`} variant="ghost">
                <Undo2 className="size-4" />
            </Button>
            <Button aria-label={t`Redo (Ctrl+Shift+Z)`} disabled={!canRedo} onClick={handleRedo} size="icon" title={t`Redo (Ctrl+Shift+Z)`} variant="ghost">
                <Redo2 className="size-4" />
            </Button>

            <Popover>
                <PopoverTrigger
                    render={
                        <Button className="gap-2" size="sm" variant="outline">
                            <History className="size-4" />
                            <Trans>History</Trans>
                            {entries.length > 0 && <span className="text-muted-foreground text-xs">({entries.length})</span>}
                        </Button>
                    }
                />
                <PopoverContent align="end" className="w-80 p-0">
                    <div className="border-b p-4">
                        <h4 className="font-medium">
                            <Trans>Version History</Trans>
                        </h4>
                        <p className="text-muted-foreground mt-1 text-sm">
                            <Trans>Browse and restore previous versions of your workflow.</Trans>
                        </p>
                    </div>

                    <ScrollArea className="h-[300px]">
                        <div className="space-y-1 p-2">
                            {entries.length === 0 ? (
                                <div className="text-muted-foreground flex flex-col items-center justify-center py-8">
                                    <RotateCcw className="mb-2 size-8 opacity-50" />
                                    <p className="text-sm">
                                        <Trans>No history yet</Trans>
                                    </p>
                                    <p className="text-xs">
                                        <Trans>Changes will appear here</Trans>
                                    </p>
                                </div>
                            ) : (
                                entries.map((entry, index) => (
                                    <HistoryEntryItem entry={entry} isCurrent={index === currentIndex} key={entry.id} onRestore={handleRestore} />
                                ))
                            )}
                        </div>
                    </ScrollArea>

                    {entries.length > 0 && (
                        <>
                            <Separator />
                            <div className="p-2">
                                <p className="text-muted-foreground text-center text-xs">
                                    <Trans>Up to {MAX_HISTORY_ENTRIES} versions saved</Trans>
                                </p>
                            </div>
                        </>
                    )}
                </PopoverContent>
            </Popover>
        </div>
    );
};

export default VersionHistory;
