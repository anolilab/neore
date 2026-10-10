"use client";

import { useLingui } from "@lingui/react/macro";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { FileInput } from "lucide-react";
import type { FC } from "react";

import TooltipIconButton from "@/features/chat/components/tooltip-icon-button";
import { useCRPC } from "@/lib/lunora/crpc";
import { showError } from "@/lib/toast";

/** Canvas header action: copies a text artifact into a new page and opens it. */
const OpenAsPageButton: FC<{ documentId: string }> = ({ documentId }) => {
    const { t } = useLingui();
    const crpc = useCRPC();
    const navigate = useNavigate();
    const { isPending, mutate } = useMutation(crpc.pages.functions.createPageFromDocument.mutationOptions());

    return (
        <TooltipIconButton
            aria-busy={isPending}
            disabled={isPending}
            onClick={() =>
                mutate(
                    { documentId: documentId as never },
                    {
                        onError: (error) => showError(error instanceof Error ? error : t`Could not open as a page`),
                        onSuccess: ({ pageId }) => {
                            void navigate({ params: { pageId }, to: "/pages/$pageId" });
                        },
                    },
                )
            }
            tooltip={t`Open as page`}
        >
            <FileInput aria-hidden="true" className="size-4" />
        </TooltipIconButton>
    );
};

export default OpenAsPageButton;
