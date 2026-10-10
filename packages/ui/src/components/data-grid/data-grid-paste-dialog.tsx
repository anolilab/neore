"use client";

import { Plural, useLingui } from "@lingui/react/macro";
import type { RowData, TableMeta } from "@tanstack/react-table";
import { Button } from "@ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@ui/components/dialog";
import { useAsRef } from "@ui/hooks/use-as-ref";
import type { DataGridFeatures } from "@ui/lib/data-grid-features";
import type { PasteDialogState } from "@ui/types/data-grid";
import cn from "@ui/utils/cn";
import * as React from "react";

interface DataGridPasteDialogProps<TData extends RowData> {
    pasteDialog: PasteDialogState;
    tableMeta: TableMeta<DataGridFeatures, TData>;
}

// Inlined at the two call sites rather than wrapped in a component: the label
// must nest a real `input` for the association to be visible to a reader.
const radioItemClassName = cn(
    "border-input bg-background relative size-4 shrink-0 appearance-none rounded-full border shadow-xs transition-[color,box-shadow] outline-none",
    "text-primary focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
    "disabled:cursor-not-allowed disabled:opacity-50",
    "checked:before:bg-primary checked:before:absolute checked:before:start-1/2 checked:before:top-1/2 checked:before:size-2 checked:before:-translate-x-1/2 checked:before:-translate-y-1/2 checked:before:rounded-full checked:before:content-['']",
    "dark:bg-input/30",
);

const DataGridPasteDialog = <TData extends RowData>({ pasteDialog, tableMeta }: DataGridPasteDialogProps<TData>) => {
    if (!pasteDialog.open) {
        return null;
    }

    const onPasteDialogOpenChange = tableMeta?.onPasteDialogOpenChange;
    const onCellsPaste = tableMeta?.onCellsPaste;

    return <PasteDialog onCellsPaste={onCellsPaste} onPasteDialogOpenChange={onPasteDialogOpenChange} pasteDialog={pasteDialog} />;
};

interface PasteDialogProps
    extends
        Pick<TableMeta<DataGridFeatures, RowData>, "onPasteDialogOpenChange" | "onCellsPaste">,
        Required<Pick<TableMeta<DataGridFeatures, RowData>, "pasteDialog">> {}

const PasteDialog = React.memo(PasteDialogImpl, (prev, next) => {
    if (prev.pasteDialog.open !== next.pasteDialog.open) {
        return false;
    }

    if (!next.pasteDialog.open) {
        return true;
    }

    return prev.pasteDialog.rowsNeeded === next.pasteDialog.rowsNeeded;
});

function PasteDialogImpl({ onCellsPaste, onPasteDialogOpenChange, pasteDialog }: PasteDialogProps) {
    const { t } = useLingui();
    const propsRef = useAsRef({
        onCellsPaste,
        onPasteDialogOpenChange,
    });

    const expandRadioRef = React.useRef<HTMLInputElement | null>(null);
    const expandOptionId = React.useId();
    const keepOptionId = React.useId();

    const onOpenChange = React.useCallback(
        (open: boolean) => {
            propsRef.current.onPasteDialogOpenChange?.(open);
        },
        [propsRef],
    );

    const onCancel = React.useCallback(() => {
        propsRef.current.onPasteDialogOpenChange?.(false);
    }, [propsRef]);

    const onContinue = React.useCallback(() => {
        propsRef.current.onCellsPaste?.(expandRadioRef.current?.checked ?? false);
    }, [propsRef]);

    const { rowsNeeded } = pasteDialog;

    return (
        <Dialog onOpenChange={onOpenChange} open={pasteDialog.open}>
            <DialogContent data-grid-popover="">
                <DialogHeader>
                    <DialogTitle>{t`Do you want to add more rows?`}</DialogTitle>
                    <DialogDescription>
                        <Plural
                            one="We need # additional row to paste everything from your clipboard."
                            other="We need # additional rows to paste everything from your clipboard."
                            value={rowsNeeded}
                        />
                    </DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3 py-1">
                    <label className="flex cursor-pointer items-start gap-3" htmlFor={expandOptionId}>
                        <input
                            className={radioItemClassName}
                            defaultChecked
                            id={expandOptionId}
                            name="expand-option"
                            ref={expandRadioRef}
                            type="radio"
                            value="expand"
                        />
                        <div className="flex flex-col gap-1">
                            <span className="text-sm leading-none font-medium">{t`Create new rows`}</span>
                            <span className="text-muted-foreground text-sm">
                                <Plural
                                    one="Add # new row to the table and paste all data"
                                    other="Add # new rows to the table and paste all data"
                                    value={rowsNeeded}
                                />
                            </span>
                        </div>
                    </label>
                    <label className="flex cursor-pointer items-start gap-3" htmlFor={keepOptionId}>
                        <input className={radioItemClassName} id={keepOptionId} name="expand-option" type="radio" value="no-expand" />
                        <div className="flex flex-col gap-1">
                            <span className="text-sm leading-none font-medium">{t`Keep current rows`}</span>
                            <span className="text-muted-foreground text-sm">{t`Paste only what fits in the existing rows`}</span>
                        </div>
                    </label>
                </div>
                <DialogFooter>
                    <Button onClick={onCancel} variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button onClick={onContinue}>{t`Continue`}</Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export default DataGridPasteDialog;
