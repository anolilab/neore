import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@neore/ui/components/tooltip";
import { Check, Copy } from "lucide-react";
import type { FC } from "react";
import { useEffect, useState } from "react";

const CopyButton: FC<{
    textToCopy: string;
}> = ({ textToCopy }) => {
    const { t } = useLingui();

    const [isCopied, setIsCopied] = useState(false);

    useEffect(() => {
        if (isCopied) {
            const timer = setTimeout(() => {
                setIsCopied(false);
            }, 2000);

            return () => {
                clearTimeout(timer);
            };
        }

        return () => {};
    }, [isCopied]);

    const handleCopy = async () => {
        try {
            await navigator.clipboard.writeText(textToCopy);
            setIsCopied(true);
        } catch (error) {
            console.error("Failed to copy text:", error);
        }
    };

    return (
        <TooltipProvider>
            <Tooltip>
                <TooltipTrigger
                    render={
                        <Button className="h-8 w-8" onClick={handleCopy} size="icon" variant="link">
                            {isCopied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                            <span className="sr-only">${t`Copy to clipboard`}</span>
                        </Button>
                    }
                />
                <TooltipContent>
                    <p>{isCopied ? t`Copied!` : t`Copy to clipboard`}</p>
                </TooltipContent>
            </Tooltip>
        </TooltipProvider>
    );
};

export default CopyButton;
