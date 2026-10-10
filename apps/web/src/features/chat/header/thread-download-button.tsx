"use client";

import { useLingui } from "@lingui/react/macro";
import { api } from "@neore/backend/api";
import type { Doc, Id } from "@neore/backend/dataModel";
import { Button } from "@neore/ui/components/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@neore/ui/components/responsive-dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { ClipboardCopyIcon, DownloadIcon, FileJsonIcon, FileTextIcon, FileTypeIcon } from "lucide-react";
import type { FC } from "react";
import { useCallback, useState } from "react";
import { toast } from "sonner";

import type { DownloadFormat } from "@/lib/download";
import { formatAsMarkdown, handleDownload } from "@/lib/download";
import { useLunora } from "@/lib/lunora/crpc";

interface Props {
    model?: string;
    threadId?: string;
}

const ThreadDownloadButton: FC<Props> = ({ model, threadId }) => {
    const { t } = useLingui();
    const [loading, setLoading] = useState(false);
    const lunora = useLunora();

    const fetchThread = useCallback(async () => {
        if (!threadId || !model) {
            return null;
        }

        // `threadId` is the `/chat/$threadId` route param, passed down as a plain string.
        const data = await lunora.query(api.chat.functions.getFullThreadForExport, { model, threadId: threadId as Id<"threads"> });

        if (!data?.thread || !data?.messages) {
            toast.error(t`No data to export`);

            return null;
        }

        return data;
    }, [lunora, model, threadId, t]);

    const handleCopyMarkdown = useCallback(async () => {
        setLoading(true);

        try {
            const data = await fetchThread();

            if (!data) {
                return;
            }

            // `getFullThreadForExport` returns the public thread projection (same fields,
            // unbranded ids); the exporter only reads `title`.
            const markdown = formatAsMarkdown(data.thread as unknown as Doc<"threads">, data.messages as unknown as Doc<"messages">[]);

            await navigator.clipboard.writeText(markdown);
            toast.success(t`Chat copied to clipboard as Markdown`);
        } catch {
            toast.error(t`Failed to copy chat`);
        } finally {
            setLoading(false);
        }
    }, [fetchThread, t]);

    const handleDownloadFormat = useCallback(
        async (format: DownloadFormat) => {
            setLoading(true);

            try {
                const data = await fetchThread();

                if (!data) {
                    return;
                }

                await handleDownload(data.thread as unknown as Doc<"threads">, data.messages as unknown as Doc<"messages">[], format);
            } catch {
                toast.error(t`Failed to export`);
            } finally {
                setLoading(false);
            }
        },
        [fetchThread, t],
    );

    const isDisabled = !threadId || !model || loading;

    return (
        <Tooltip>
            <DropdownMenu>
                <TooltipTrigger
                    render={
                        <DropdownMenuTrigger
                            render={
                                <Button disabled={isDisabled} size="icon" variant="ghost">
                                    <DownloadIcon className="h-4 w-4" />
                                    <span className="sr-only">{t`Export chat`}</span>
                                </Button>
                            }
                        />
                    }
                />
                <DropdownMenuContent align="end" side="bottom">
                    <DropdownMenuItem onClick={handleCopyMarkdown}>
                        <ClipboardCopyIcon className="size-4" />
                        {t`Copy as Markdown`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownloadFormat("md")}>
                        <FileTextIcon className="size-4" />
                        {t`Download Markdown`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownloadFormat("pdf")}>
                        <FileTypeIcon className="size-4" />
                        {t`Download PDF`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownloadFormat("txt")}>
                        <FileTextIcon className="size-4" />
                        {t`Download Text`}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => handleDownloadFormat("json")}>
                        <FileJsonIcon className="size-4" />
                        {t`Download JSON`}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
            <TooltipContent side="bottom">{t`Export chat`}</TooltipContent>
        </Tooltip>
    );
};

export default ThreadDownloadButton;
