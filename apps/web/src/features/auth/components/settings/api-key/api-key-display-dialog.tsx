"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";

interface APIKeyDisplayDialogProperties extends ComponentProps<typeof Dialog> {
    apiKey: string;

    classNames?: SettingsCardClassNames;
}

const APIKeyDisplayDialog = ({ apiKey, classNames, onOpenChange, ...properties }: APIKeyDisplayDialogProperties) => {
    const [copied, setCopied] = useState(false);
    const { t } = useLingui();

    const handleCopy = () => {
        navigator.clipboard.writeText(apiKey);
        setCopied(true);
        setTimeout(() => {
            setCopied(false);
        }, 2000);
    };

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent
                className={classNames?.dialog?.content}
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                }}
            >
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`API Key Created`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Your API key has been created successfully. Make sure to copy it now as you won't be able to see it again.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="bg-muted rounded-md p-4 font-mono text-sm break-all">{apiKey}</div>

                <DialogFooter className={classNames?.dialog?.footer}>
                    <Button
                        className={cn(classNames?.button, classNames?.outlineButton)}
                        disabled={copied}
                        onClick={handleCopy}
                        type="button"
                        variant="outline"
                    >
                        {copied ? (
                            <>
                                <CheckIcon className={classNames?.icon} />
                                {t`Copied to clipboard`}
                            </>
                        ) : (
                            <>
                                <CopyIcon className={classNames?.icon} />
                                {t`Copy to clipboard`}
                            </>
                        )}
                    </Button>

                    <Button className={cn(classNames?.button, classNames?.primaryButton)} onClick={() => onOpenChange?.(false)} type="button" variant="default">
                        {t`Done`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default APIKeyDisplayDialog;
