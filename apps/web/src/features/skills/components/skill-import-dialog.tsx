"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import { parseSkillMarkdown, validateSkillFiles } from "@neore/backend/skills/markdown";
import { Button } from "@neore/ui/components/button";
import { Label } from "@neore/ui/components/label";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/responsive-dialog";
import { Textarea } from "@neore/ui/components/textarea";
import { useMutation } from "@tanstack/react-query";
import { FileUpIcon, Loader2Icon } from "lucide-react";
import type { ChangeEvent, FC } from "react";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { useLunoraActionOptions } from "@/lib/lunora/crpc";
import { loadJsZip } from "@/lib/zip";

import type { SkillUpload } from "../lib/skill-archive";
import { readSkillUpload, SkillArchiveTooLargeError } from "../lib/skill-archive";

/** Outside the component: a conditional inside a `catch` makes the React Compiler skip it. */
const describeReadError = (error: unknown, fallback: string, tooLarge: (megabytes: number) => string): string => {
    if (error instanceof SkillArchiveTooLargeError) {
        return tooLarge(error.maxMegabytes);
    }

    return error instanceof Error ? error.message : fallback;
};

interface SkillImportDialogProps {
    onClose: () => void;
    onImported: () => void;
    open: boolean;
}

/**
 * Import a skill from a SKILL.md (Claude / Agent Skills format), a skill `.zip`
 * (SKILL.md plus `references/`, `scripts/`, `assets/`), or pasted markdown.
 * The preview parses with the same rules the server applies; the server
 * re-checks everything on import.
 */
const SkillImportDialogBody: FC<Omit<SkillImportDialogProps, "open">> = ({ onClose, onImported }) => {
    const { t } = useLingui();
    const [upload, setUpload] = useState<SkillUpload>({ filename: "SKILL.md", files: [], markdown: "" });
    const [readError, setReadError] = useState<string | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const markdownId = useId();
    const { isPending, mutateAsync: importSkill } = useMutation(useLunoraActionOptions(api.skills.io.importSkill));

    const preview = useMemo(() => {
        if (!upload.markdown.trim()) {
            return undefined;
        }

        const parsed = parseSkillMarkdown(upload.markdown);
        const fileErrors = validateSkillFiles(upload.files);

        return parsed.ok && fileErrors.length > 0 ? { errors: fileErrors, ok: false as const } : parsed;
    }, [upload]);

    const handleFile = async (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.target;
        const file = input.files?.[0];

        input.value = "";

        if (!file) {
            return;
        }

        try {
            setUpload(await readSkillUpload(file, loadJsZip));
            setReadError(null);
        } catch (error) {
            setReadError(describeReadError(error, t`This file could not be read.`, (megabytes) => t`The file is larger than ${megabytes} MB.`));
        }
    };

    const handleImport = async () => {
        try {
            const result = await importSkill({ filename: upload.filename, files: upload.files, markdown: upload.markdown });

            for (const warning of result.warnings) {
                toast.warning(warning);
            }

            toast.success(t`Imported skill "${result.slug}"`);
            onImported();
            onClose();
        } catch (error) {
            toast.error(error instanceof Error && error.message ? error.message : t`The skill could not be imported.`);
        }
    };

    return (
        <>
            <DialogHeader>
                <DialogTitle>{t`Import skill`}</DialogTitle>
                <DialogDescription>{t`Upload a SKILL.md or a skill .zip (as used by Claude and other Agent Skills tools), or paste the markdown.`}</DialogDescription>
            </DialogHeader>
            <DialogPanel className="space-y-4">
                <div className="flex items-center gap-2">
                    <Button onClick={() => fileInput.current?.click()} type="button" variant="outline">
                        <FileUpIcon aria-hidden="true" className="mr-2 size-4" />
                        {t`Choose .md or .zip`}
                    </Button>
                    {upload.filename !== "SKILL.md" && <span className="text-muted-foreground truncate text-xs">{upload.filename}</span>}
                    <input
                        accept=".md,.markdown,.zip,text/markdown,application/zip"
                        aria-hidden="true"
                        className="hidden"
                        onChange={handleFile}
                        ref={fileInput}
                        tabIndex={-1}
                        type="file"
                    />
                </div>
                <div className="space-y-1.5">
                    <Label htmlFor={markdownId}>{t`SKILL.md`}</Label>
                    <Textarea
                        className="max-h-72 font-mono text-xs"
                        id={markdownId}
                        onChange={(event) => setUpload({ filename: "SKILL.md", files: [], markdown: event.target.value })}
                        placeholder={"---\nname: my-skill\ndescription: What it does and when to use it.\n---\n\nInstructions…"}
                        rows={10}
                        value={upload.markdown}
                    />
                </div>
                <div aria-live="polite" role="status">
                    {readError && <p className="text-destructive text-sm">{readError}</p>}
                    {preview && !preview.ok && (
                        <ul className="text-destructive list-disc space-y-0.5 pl-5 text-sm">
                            {preview.errors.map((error) => (
                                <li key={error}>{error}</li>
                            ))}
                        </ul>
                    )}
                    {preview?.ok && (
                        <div className="bg-muted/50 space-y-1 rounded-md p-3 text-sm">
                            <p className="font-medium">
                                {preview.skill.name} <span className="text-muted-foreground font-normal">/{preview.skill.slug}</span>
                            </p>
                            <p className="text-muted-foreground line-clamp-3 text-xs">{preview.skill.description}</p>
                            {upload.files.length > 0 && <p className="text-muted-foreground text-xs">{t`${upload.files.length} additional file(s)`}</p>}
                            {preview.warnings.map((warning) => (
                                <p className="text-xs text-amber-600 dark:text-amber-400" key={warning}>
                                    {warning}
                                </p>
                            ))}
                        </div>
                    )}
                </div>
            </DialogPanel>
            <DialogFooter>
                <Button onClick={onClose} type="button" variant="outline">
                    {t`Cancel`}
                </Button>
                <Button disabled={!preview?.ok || isPending} onClick={handleImport} type="button">
                    {isPending && <Loader2Icon aria-hidden="true" className="mr-2 size-4 animate-spin" />}
                    {t`Import`}
                </Button>
            </DialogFooter>
        </>
    );
};

const SkillImportDialog: FC<SkillImportDialogProps> = ({ open, ...props }) => (
    <Dialog onOpenChange={(next) => !next && props.onClose()} open={open}>
        <DialogContent className="sm:max-w-2xl">{open && <SkillImportDialogBody {...props} />}</DialogContent>
    </Dialog>
);

export default SkillImportDialog;
