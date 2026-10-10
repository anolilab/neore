"use client";

import { useLingui } from "@lingui/react/macro";
import type { Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { useMutation } from "@tanstack/react-query";
import { useId, useState } from "react";
import { toast } from "sonner";

import { useCRPC } from "@/lib/lunora/crpc";

import { detectImportFormat, IMPORT_MAX_BYTES } from "../lib/evals-format";

interface ImportCasesDialogProps {
    datasetId: Id<"evalDatasets">;
    onClose: () => void;
    open: boolean;
}

const CSV_EXAMPLE = `input,expected_answer,rubric,expected_sources,contains
"What is our refund window?","30 days","Mentions the receipt requirement",refunds.pdf,30 days`;

const JSONL_EXAMPLE = `{"input":"What is our refund window?","expectedAnswer":"30 days","checks":[{"kind":"contains","value":"30 days"}]}`;

const ImportCasesBody = ({ datasetId, onClose }: Omit<ImportCasesDialogProps, "open">) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const baseId = useId();
    const importCases = useMutation(crpc.evals.functions.importCases.mutationOptions());
    const [file, setFile] = useState<File | null>(null);
    const [errors, setErrors] = useState<{ line: number; message: string }[]>([]);

    const handleSubmit = async () => {
        if (!file) {
            return;
        }

        if (file.size > IMPORT_MAX_BYTES) {
            setErrors([{ line: 1, message: t`The file is larger than 512 KB.` }]);

            return;
        }

        try {
            const content = await file.text();
            const result = await importCases.mutateAsync({ content, datasetId, format: detectImportFormat(file.name) });

            if (result.errors.length > 0) {
                setErrors(result.errors);

                return;
            }

            toast.success(t`Imported ${String(result.imported)} cases`);
            onClose();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`Failed to import cases`);
        }
    };

    return (
        <DialogContent className="max-w-2xl">
            <DialogHeader>
                <DialogTitle>{t`Import cases`}</DialogTitle>
                <DialogDescription>{t`Upload a CSV or JSONL file. Nothing is imported if any row is invalid.`}</DialogDescription>
            </DialogHeader>
            <form
                className="contents"
                noValidate
                onSubmit={(event) => {
                    event.preventDefault();
                    void handleSubmit();
                }}
            >
                <DialogPanel>
                    <div className="space-y-4">
                        <div className="space-y-2">
                            <Label htmlFor={`${baseId}-file`}>{t`File`}</Label>
                            <Input
                                accept=".csv,.jsonl,.ndjson,text/csv,application/x-ndjson"
                                aria-describedby={`${baseId}-formats`}
                                id={`${baseId}-file`}
                                onChange={(event) => {
                                    setFile(event.target.files?.[0] ?? null);
                                    setErrors([]);
                                }}
                                type="file"
                            />
                        </div>
                        <div className="text-muted-foreground space-y-2 text-xs" id={`${baseId}-formats`}>
                            <p>{t`CSV needs a header row with an "input" column. Optional columns: expected_answer, rubric, expected_sources (separated by ;), and one column per check: contains, not_contains, exact, regex, json_schema, max_latency_ms, max_cost_usd.`}</p>
                            <pre className="bg-muted overflow-x-auto rounded p-2 font-mono">{CSV_EXAMPLE}</pre>
                            <p>{t`JSONL has one case per line:`}</p>
                            <pre className="bg-muted overflow-x-auto rounded p-2 font-mono">{JSONL_EXAMPLE}</pre>
                        </div>
                        {errors.length > 0 && (
                            <div aria-live="assertive" className="border-destructive/40 bg-destructive/5 rounded-md border p-3" role="alert">
                                <p className="text-destructive text-sm font-medium">{t`The file was not imported:`}</p>
                                <ul className="mt-2 max-h-48 list-disc space-y-1 overflow-y-auto pl-5 text-xs">
                                    {errors.map((error) => (
                                        <li key={`${String(error.line)}-${error.message}`}>{t`Line ${String(error.line)}: ${error.message}`}</li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </div>
                </DialogPanel>
                <DialogFooter>
                    <Button onClick={onClose} type="button" variant="outline">
                        {t`Cancel`}
                    </Button>
                    <Button aria-busy={importCases.isPending} disabled={!file || importCases.isPending} type="submit">
                        {t`Import`}
                    </Button>
                </DialogFooter>
            </form>
        </DialogContent>
    );
};

const ImportCasesDialog = ({ open, ...props }: ImportCasesDialogProps) => (
    <Dialog onOpenChange={(nextOpen) => !nextOpen && props.onClose()} open={open}>
        {open && <ImportCasesBody {...props} />}
    </Dialog>
);

export default ImportCasesDialog;
