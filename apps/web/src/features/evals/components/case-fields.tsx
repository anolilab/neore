"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Checkbox } from "@neore/ui/components/checkbox";
import { Input } from "@neore/ui/components/input";
import { Label } from "@neore/ui/components/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@neore/ui/components/select";
import { Textarea } from "@neore/ui/components/textarea";
import { useQuery } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import type { Dispatch, SetStateAction } from "react";
import { useId } from "react";

import { useCRPC } from "@/lib/lunora/crpc";

import type { CaseFormValues, CheckRow, EvalCheckKind } from "../lib/evals-format";
import { CHECK_KINDS, EXPECTED_MAX, INPUT_MAX, MAX_CHECKS, RUBRIC_MAX } from "../lib/evals-format";

export const useCheckLabels = (): Record<EvalCheckKind, { hint: string; label: string }> => {
    const { t } = useLingui();

    return {
        contains: { hint: t`Text the answer must contain (case-insensitive)`, label: t`Contains` },
        exact: { hint: t`The whole answer, exactly`, label: t`Exact match` },
        json_schema: { hint: t`A JSON Schema the answer must satisfy`, label: t`JSON schema` },
        max_cost_usd: { hint: t`Most the case may cost, in US dollars`, label: t`Max cost ($)` },
        max_latency_ms: { hint: t`Longest the answer may take, in milliseconds`, label: t`Max latency (ms)` },
        not_contains: { hint: t`Text the answer must not contain`, label: t`Does not contain` },
        regex: { hint: t`A regular expression the answer must match`, label: t`Regex` },
    };
};

interface CaseFieldsProps {
    /** Show the expected-sources field (retrieval datasets). */
    rag: boolean;
    setValues: Dispatch<SetStateAction<CaseFormValues>>;
    showErrors: boolean;
    values: CaseFormValues;
}

/** The fields of one eval case: input, expected answer, rubric, expected sources and the check editor. */
const CaseFields = ({ rag, setValues, showErrors, values }: CaseFieldsProps) => {
    const { t } = useLingui();
    const baseId = useId();
    const checkLabels = useCheckLabels();
    const crpc = useCRPC();
    const { data: files = [] } = useQuery({ ...crpc.knowledge.functions.listFiles.queryOptions({}), enabled: rag });
    const indexedFiles = files.filter((file) => file.status === "indexed");
    const inputError = showErrors && !values.input.trim() ? t`Input is required` : undefined;

    const set = <K extends keyof CaseFormValues>(key: K, value: CaseFormValues[K]) =>
        setValues((previous) => {
            return { ...previous, [key]: value };
        });

    const toggleFile = (fileId: string, checked: boolean) =>
        set("expectedFileIds", checked ? [...values.expectedFileIds, fileId] : values.expectedFileIds.filter((existing) => existing !== fileId));

    const updateCheck = (index: number, patch: Partial<CheckRow>) =>
        set(
            "checks",
            values.checks.map((check, position) => (position === index ? { ...check, ...patch } : check)),
        );

    return (
        <div className="space-y-4">
            <div className="space-y-2">
                <Label htmlFor={`${baseId}-input`}>{t`Input`}</Label>
                <Textarea
                    aria-describedby={inputError ? `${baseId}-input-error` : undefined}
                    aria-invalid={!!inputError}
                    className="min-h-24"
                    id={`${baseId}-input`}
                    maxLength={INPUT_MAX}
                    onChange={(event) => set("input", event.target.value)}
                    required
                    value={values.input}
                />
                {inputError && (
                    <p className="text-destructive text-xs" id={`${baseId}-input-error`}>
                        {inputError}
                    </p>
                )}
            </div>
            <div className="space-y-2">
                <Label htmlFor={`${baseId}-expected`}>{t`Expected answer`}</Label>
                <Textarea
                    aria-describedby={`${baseId}-expected-hint`}
                    id={`${baseId}-expected`}
                    maxLength={EXPECTED_MAX}
                    onChange={(event) => set("expectedAnswer", event.target.value)}
                    value={values.expectedAnswer}
                />
                <p className="text-muted-foreground text-xs" id={`${baseId}-expected-hint`}>
                    {t`Optional. The judge compares the answer with it; wording may differ, facts may not.`}
                </p>
            </div>
            <div className="space-y-2">
                <Label htmlFor={`${baseId}-rubric`}>{t`Rubric`}</Label>
                <Textarea
                    aria-describedby={`${baseId}-rubric-hint`}
                    id={`${baseId}-rubric`}
                    maxLength={RUBRIC_MAX}
                    onChange={(event) => set("rubric", event.target.value)}
                    value={values.rubric}
                />
                <p className="text-muted-foreground text-xs" id={`${baseId}-rubric-hint`}>
                    {t`Optional. Criteria the judge grades the answer against.`}
                </p>
            </div>
            {rag && (
                <fieldset className="space-y-2">
                    <legend className="text-sm font-medium">{t`Expected source documents`}</legend>
                    <p className="text-muted-foreground text-xs">{t`The documents the answer should be retrieved from. Used for hit rate, MRR, precision and recall.`}</p>
                    {indexedFiles.length > 0 && (
                        <ul className="max-h-40 space-y-2 overflow-y-auto">
                            {indexedFiles.map((file) => {
                                const id = `${baseId}-file-${file._id}`;

                                return (
                                    <li className="flex items-center gap-2" key={file._id}>
                                        <Checkbox
                                            checked={values.expectedFileIds.includes(file._id)}
                                            id={id}
                                            onCheckedChange={(checked) => toggleFile(file._id, checked)}
                                        />
                                        <Label className="font-normal" htmlFor={id}>
                                            {file.name}
                                        </Label>
                                    </li>
                                );
                            })}
                        </ul>
                    )}
                    <Label htmlFor={`${baseId}-sources`}>{t`Other file names`}</Label>
                    <Textarea
                        aria-describedby={`${baseId}-sources-hint`}
                        id={`${baseId}-sources`}
                        onChange={(event) => set("expectedSources", event.target.value)}
                        placeholder="handbook.pdf"
                        value={values.expectedSources}
                    />
                    <p className="text-muted-foreground text-xs" id={`${baseId}-sources-hint`}>
                        {t`One per line, matched by file name — for files not in your knowledge base yet.`}
                    </p>
                </fieldset>
            )}
            <fieldset className="space-y-2">
                <legend className="text-sm font-medium">{t`Checks`}</legend>
                <p className="text-muted-foreground text-xs">{t`Deterministic checks every answer must pass.`}</p>
                {values.checks.length > 0 && (
                    <ul className="space-y-2">
                        {values.checks.map((check, index) => {
                            const rowId = `${baseId}-check-${String(index)}`;

                            return (
                                // eslint-disable-next-line react-x/no-array-index-key -- rows have no identity beyond their position
                                <li className="flex flex-wrap items-start gap-2" key={index}>
                                    <Select
                                        items={CHECK_KINDS.map((kind) => {
                                            return { label: checkLabels[kind].label, value: kind };
                                        })}
                                        onValueChange={(value) => updateCheck(index, { kind: (value ?? "contains") as EvalCheckKind })}
                                        value={check.kind}
                                    >
                                        <SelectTrigger aria-label={t`Check ${String(index + 1)} type`} className="w-44">
                                            <SelectValue />
                                        </SelectTrigger>
                                        <SelectContent>
                                            {CHECK_KINDS.map((kind) => (
                                                <SelectItem key={kind} value={kind}>
                                                    {checkLabels[kind].label}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                    {check.kind === "json_schema" ? (
                                        <Textarea
                                            aria-describedby={`${rowId}-hint`}
                                            aria-label={t`Check ${String(index + 1)} value`}
                                            className="min-h-16 min-w-0 flex-1 font-mono text-xs"
                                            onChange={(event) => updateCheck(index, { value: event.target.value })}
                                            placeholder='{"type":"object","required":["answer"]}'
                                            value={check.value}
                                        />
                                    ) : (
                                        <Input
                                            aria-describedby={`${rowId}-hint`}
                                            aria-label={t`Check ${String(index + 1)} value`}
                                            className="min-w-0 flex-1"
                                            inputMode={check.kind === "max_cost_usd" || check.kind === "max_latency_ms" ? "decimal" : undefined}
                                            onChange={(event) => updateCheck(index, { value: event.target.value })}
                                            value={check.value}
                                        />
                                    )}
                                    <Button
                                        aria-label={t`Remove check ${String(index + 1)}`}
                                        onClick={() =>
                                            set(
                                                "checks",
                                                values.checks.filter((_, position) => position !== index),
                                            )
                                        }
                                        size="icon"
                                        type="button"
                                        variant="ghost"
                                    >
                                        <Trash2 aria-hidden />
                                    </Button>
                                    <p className="text-muted-foreground w-full text-xs" id={`${rowId}-hint`}>
                                        {checkLabels[check.kind].hint}
                                    </p>
                                </li>
                            );
                        })}
                    </ul>
                )}
                <Button
                    disabled={values.checks.length >= MAX_CHECKS}
                    onClick={() => set("checks", [...values.checks, { kind: "contains", value: "" }])}
                    size="sm"
                    type="button"
                    variant="outline"
                >
                    <Plus aria-hidden />
                    {t`Add check`}
                </Button>
            </fieldset>
        </div>
    );
};

export default CaseFields;
