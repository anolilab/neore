"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Input } from "@neore/ui/components/input";
import { FileArchiveIcon, FolderUpIcon, LinkIcon, Loader2Icon } from "lucide-react";
import type { ChangeEvent, FC, FormEvent } from "react";
import { useId, useRef, useState } from "react";

import type { CollectionId } from "@/features/knowledge/hooks/use-knowledge-import";
import useKnowledgeImport from "@/features/knowledge/hooks/use-knowledge-import";
import { collectFolderDocuments } from "@/features/knowledge/lib/documents";

interface KnowledgeImportActionsProps {
    /** The caller's own collection the imports go into; uncategorised when absent. */
    collectionId?: CollectionId;
    onChange: () => void;
}

/** Folder upload, Notion export import and "add a web page", next to the drop zone. */
const KnowledgeImportActions: FC<KnowledgeImportActionsProps> = ({ collectionId, onChange }) => {
    const { t } = useLingui();
    const { addUrl, importFolder, importNotionExport, isAddingUrl, isImporting, progress } = useKnowledgeImport(onChange);
    const [url, setUrl] = useState("");
    const folderInput = useRef<HTMLInputElement>(null);
    const zipInput = useRef<HTMLInputElement>(null);
    const urlId = useId();
    const busy = isImporting;

    const handleFolder = async (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.target;
        const files = [...(input.files ?? [])];

        input.value = "";

        const { accepted, skipped } = collectFolderDocuments(files);

        await importFolder(accepted, skipped.length, collectionId);
    };

    const handleZip = async (event: ChangeEvent<HTMLInputElement>) => {
        const input = event.target;
        const file = input.files?.[0];

        input.value = "";

        if (file) {
            await importNotionExport(file, collectionId);
        }
    };

    const handleUrl = async (event: FormEvent) => {
        event.preventDefault();

        if (url.trim() && (await addUrl(url.trim(), collectionId))) {
            setUrl("");
        }
    };

    return (
        <div className="space-y-2">
            <div className="flex flex-wrap gap-2">
                <Button disabled={busy} onClick={() => folderInput.current?.click()} size="sm" type="button" variant="outline">
                    <FolderUpIcon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {t`Upload folder`}
                </Button>
                <Button disabled={busy} onClick={() => zipInput.current?.click()} size="sm" type="button" variant="outline">
                    <FileArchiveIcon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5" />
                    {t`Import Notion export (.zip)`}
                </Button>
                {/* `webkitdirectory` keeps each file's path inside the folder (`webkitRelativePath`). */}
                <input
                    aria-hidden="true"
                    className="hidden"
                    multiple
                    onChange={handleFolder}
                    ref={folderInput}
                    tabIndex={-1}
                    type="file"
                    {...{ directory: "", webkitdirectory: "" }}
                />
                <input accept=".zip,application/zip" aria-hidden="true" className="hidden" onChange={handleZip} ref={zipInput} tabIndex={-1} type="file" />
            </div>

            <form className="flex gap-2" noValidate onSubmit={handleUrl}>
                <label className="sr-only" htmlFor={urlId}>
                    {t`Web page URL`}
                </label>
                <div className="relative flex-1">
                    <LinkIcon aria-hidden="true" className="text-muted-foreground absolute top-1/2 left-2.5 h-3.5 w-3.5 -translate-y-1/2" />
                    <Input
                        className="h-8 pl-8 text-sm"
                        id={urlId}
                        inputMode="url"
                        onChange={(event) => setUrl(event.target.value)}
                        placeholder="https://"
                        type="url"
                        value={url}
                    />
                </div>
                <Button disabled={isAddingUrl || !url.trim()} size="sm" type="submit">
                    {isAddingUrl && <Loader2Icon aria-hidden="true" className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                    {t`Add page`}
                </Button>
            </form>

            {/* Always mounted, so a screen reader hears the text change rather than a region appearing. */}
            <p aria-live="polite" className="text-muted-foreground flex items-center gap-2 text-xs empty:hidden" role="status">
                {busy && <Loader2Icon aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />}
                {progress && t`Adding documents… ${progress.done} of ${progress.total}`}
                {busy && !progress && t`Preparing the import…`}
            </p>
        </div>
    );
};

export default KnowledgeImportActions;
