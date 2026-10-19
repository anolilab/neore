"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogTitle, DialogTrigger } from "@ui/components/dialog";
import useStreamdownAppearance from "@ui/hooks/use-streamdown-appearance";
import cn from "@ui/utils/cn";
import { Maximize2Icon } from "lucide-react";
import type { ComponentProps, FC } from "react";
import { use, useMemo, useState } from "react";
import type { ExtraProps } from "streamdown";
import { defaultComponents, StreamdownContext, TableCopyDropdown, TableDownloadDropdown } from "streamdown";

/**
 * Streamdown overrides for chat replies: long code blocks cap at 24 lines with an
 * expand toggle, and tables get an enlarge button that opens them in a dialog.
 *
 * Both wrap Streamdown's own renderers, so highlighting, the code header and the
 * table copy / download dropdowns are unchanged. Streamdown's built-in table
 * fullscreen is a plain `role="dialog"` with no focus trap; this one is Base UI.
 * `chat-markdown-components.ts` is the map a `Streamdown` takes.
 */

type CodeProps = ComponentProps<"code"> & ExtraProps & { "data-block"?: string };
type TableProps = ComponentProps<"table"> & ExtraProps;

const DefaultCode = defaultComponents.code as FC<CodeProps>;

/** A block taller than this scrolls inside its frame until expanded. */
const CODE_LINE_CAP = 24;

/** 24 lines of `text-sm` (1.25rem each) plus the code body's `p-4` padding (2rem). */
const CAPPED_CODE_HEIGHT = "32rem";

const TRAILING_NEWLINE_RE = /\n$/;
const LANGUAGE_CLASS_RE = /language-(\S+)/;

/** The values Streamdown reads as "no cap" for `tableMaxHeight`. */
const NO_MAX_HEIGHT = new Set<number | string>([0, "0", Infinity, "Infinity", "none"]);

const textLines = (children: unknown): number => (typeof children === "string" ? children.replace(TRAILING_NEWLINE_RE, "").split("\n").length : 0);

const languageOf = (className: string | undefined): string => LANGUAGE_CLASS_RE.exec(className ?? "")?.[1] ?? "";

/** Streamdown's own reading of `tableMaxHeight`: numbers are px, and the `NO_MAX_HEIGHT` values disable the cap. */
const toMaxHeight = (value: number | string): string | undefined => {
    if (NO_MAX_HEIGHT.has(value)) {
        return undefined;
    }

    return typeof value === "number" ? `${value}px` : value;
};

export const ChatCode: FC<CodeProps> = ({ children, className, ...props }) => {
    const { t } = useLingui();
    const { capLongCodeBlocks } = useStreamdownAppearance();
    const context = use(StreamdownContext);
    const [expanded, setExpanded] = useState(false);

    const lines = textLines(children);
    // Mermaid is a diagram, not text to scroll: its frame has its own controls.
    const capped = props["data-block"] !== undefined && capLongCodeBlocks && languageOf(className) !== "mermaid" && lines > CODE_LINE_CAP;
    const contextValue = useMemo(() => {
        return { ...context, codeBlockMaxHeight: expanded ? "none" : CAPPED_CODE_HEIGHT };
    }, [context, expanded]);

    if (!capped) {
        return (
            <DefaultCode className={className} {...props}>
                {children}
            </DefaultCode>
        );
    }

    return (
        <>
            <StreamdownContext value={contextValue}>
                <DefaultCode className={className} {...props}>
                    {children}
                </DefaultCode>
            </StreamdownContext>
            <Button aria-expanded={expanded} className="mb-4" onClick={() => setExpanded((value) => !value)} size="sm" type="button" variant="ghost">
                {expanded ? t`Show less` : t`Show all ${lines} lines`}
            </Button>
        </>
    );
};

export const ChatTable: FC<TableProps> = ({ children, className, node: _node, ...props }) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);
    const { tableMaxHeight } = use(StreamdownContext);
    const maxHeight = toMaxHeight(tableMaxHeight);

    const table = (
        <table className={cn("divide-border w-full divide-y", className)} data-streamdown="table" {...props}>
            {children}
        </table>
    );

    return (
        // `data-streamdown="table-wrapper"` is what Streamdown's copy and download dropdowns search from.
        <div className="border-border bg-sidebar my-4 flex flex-col gap-2 rounded-lg border p-2" data-streamdown="table-wrapper">
            <div className="flex items-center justify-end gap-1">
                <TableCopyDropdown />
                <TableDownloadDropdown />
                <Dialog onOpenChange={setOpen} open={open}>
                    <DialogTrigger
                        render={
                            <Button aria-label={t`Enlarge table`} size="icon-sm" type="button" variant="ghost">
                                <Maximize2Icon aria-hidden="true" className="size-3.5" />
                            </Button>
                        }
                    />
                    <DialogContent aria-label={t`Table`} className="max-w-[min(96vw,80rem)]">
                        <DialogTitle className="sr-only">{t`Table`}</DialogTitle>
                        <div className="border-border bg-background max-h-[75vh] overflow-auto rounded-md border">{table}</div>
                    </DialogContent>
                </Dialog>
            </div>
            <div className="border-border bg-background overflow-x-auto overflow-y-auto rounded-md border" style={maxHeight ? { maxHeight } : undefined}>
                {table}
            </div>
        </div>
    );
};
