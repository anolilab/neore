"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@neore/ui/components/tooltip";
import { MessageCircleQuestionIcon } from "lucide-react";
import type { FC } from "react";

import useOpenAside from "./open-aside";

/**
 * Composer button for a side question: opens the panel beside the thread. It
 * stays enabled while a reply streams, which is the point of it.
 */
const ComposerAskAside: FC = () => {
    const { t } = useLingui();
    const openAside = useOpenAside();

    return (
        <Tooltip>
            <TooltipTrigger
                render={
                    <Button
                        aria-label={t`Ask a side question`}
                        className="bg-sidebar border-border dark:border-sidebar-border/15 hover:bg-accent/50 dark:hover:bg-sidebar-accent/30 text-foreground h-7 gap-1 px-2 dark:text-white"
                        onClick={openAside}
                        size="sm"
                        type="button"
                        variant="outline"
                    >
                        <MessageCircleQuestionIcon aria-hidden="true" className="size-3.5" />
                    </Button>
                }
            />
            <TooltipContent>{t`Ask a side question without interrupting the reply`}</TooltipContent>
        </Tooltip>
    );
};

export default ComposerAskAside;
