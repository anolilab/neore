"use client";

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogPanel, DialogTitle } from "@neore/ui/components/dialog";
import { FileDiffIcon } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import type { UIMessage } from "@/lib/agent";

import type { PatchLineKind } from "./host-changes-lines";
import { classifyPatch } from "./host-changes-lines";

type HostChangesData = NonNullable<UIMessage["hostChanges"]>;

interface HostChangesProps {
    changes: HostChangesData;
}

const LINE_CLASS: Record<PatchLineKind, string | undefined> = {
    add: "text-green-700 dark:text-green-400",
    context: undefined,
    header: "text-muted-foreground font-medium",
    hunk: "text-muted-foreground",
    remove: "text-red-700 dark:text-red-400",
};

/**
 * What a host-run turn wrote: the files with their line counts, and the patch as it was at the end of that turn.
 * The patch is the agent's text, so it is shown as plain text in a `<pre>`, never as Markdown.
 */
const HostChanges: FC<HostChangesProps> = ({ changes }) => {
    const { t } = useLingui();
    const [open, setOpen] = useState(false);
    const { files, patch } = changes;
    const added = files.reduce((sum, file) => sum + file.added, 0);
    const removed = files.reduce((sum, file) => sum + file.removed, 0);

    return (
        <section aria-label={t`Files changed by this turn`} className="border-border my-2 rounded-md border text-sm" data-testid="host-changes">
            <div className="flex items-center justify-between gap-2 px-3 py-2">
                <p className="font-medium">
                    <Plural one="# file changed" other="# files changed" value={files.length} />{" "}
                    <span className="text-green-700 dark:text-green-400">+{added}</span> <span className="text-red-700 dark:text-red-400">−{removed}</span>
                </p>
                {typeof patch === "string" && (
                    <Button onClick={() => setOpen(true)} size="sm" type="button" variant="outline">
                        <FileDiffIcon aria-hidden="true" className="size-4" />
                        <Trans>Open diff</Trans>
                    </Button>
                )}
            </div>
            <ul className="border-border divide-border divide-y border-t">
                {files.map((file) => (
                    <li className="flex items-center justify-between gap-2 px-3 py-1" key={file.path}>
                        <span className="min-w-0 truncate font-mono text-xs">{file.path}</span>
                        <span className="shrink-0 font-mono text-xs">
                            <span className="text-green-700 dark:text-green-400">+{file.added}</span>{" "}
                            <span className="text-red-700 dark:text-red-400">−{file.removed}</span>
                        </span>
                    </li>
                ))}
            </ul>
            {typeof patch === "object" && (
                <p className="text-muted-foreground border-border border-t px-3 py-2 text-xs" role="status">
                    <Trans>The diff is too large to keep. The files and their line counts are shown.</Trans>
                </p>
            )}
            {typeof patch === "string" && (
                <Dialog onOpenChange={setOpen} open={open}>
                    <DialogContent className="max-w-3xl">
                        <DialogHeader>
                            <DialogTitle>
                                <Trans>Changes in this turn</Trans>
                            </DialogTitle>
                            <DialogDescription>
                                <Trans>The diff as it was when the turn ended. Later edits to these files are not part of it.</Trans>
                            </DialogDescription>
                        </DialogHeader>
                        <DialogPanel>
                            <pre className="overflow-x-auto font-mono text-xs leading-5" data-testid="host-changes-patch">
                                {classifyPatch(patch).map((line) => (
                                    <span className={LINE_CLASS[line.kind]} key={line.id}>
                                        {line.text}
                                        {"\n"}
                                    </span>
                                ))}
                            </pre>
                        </DialogPanel>
                    </DialogContent>
                </Dialog>
            )}
        </section>
    );
};

export default HostChanges;
