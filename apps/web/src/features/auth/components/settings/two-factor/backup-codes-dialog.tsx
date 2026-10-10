"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@neore/ui/components/responsive-dialog";
import cn from "@neore/ui/utils/cn";
import { CheckIcon, CopyIcon, DownloadIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useState } from "react";

import type { SettingsCardClassNames } from "@/components/settings/settings-card";

interface BackupCodesDialogProperties extends ComponentProps<typeof Dialog> {
    backupCodes: string[];
    classNames?: SettingsCardClassNames;
}

const BackupCodesDialog = ({ backupCodes, classNames, onOpenChange, ...properties }: BackupCodesDialogProperties) => {
    const [copied, setCopied] = useState(false);
    const { t } = useLingui();

    const handleCopy = () => {
        const codesText = backupCodes.join("\n");

        navigator.clipboard.writeText(codesText);
        setCopied(true);
        setTimeout(() => {
            setCopied(false);
        }, 2000);
    };

    const handleDownload = () => {
        const codesText = backupCodes.join("\n");
        const blob = new Blob([codesText], { type: "text/plain" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");

        a.href = url;
        a.download = "backup-codes.txt";
        // `appendChild`, not `append`: the Workers ambient types declare a global
        // `Element.append(string | Response | ReadableStream)` (HTMLRewriter) that shadows
        // the DOM `ParentNode.append` overload here. `appendChild` lives on `Node`.
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
    };

    return (
        <Dialog onOpenChange={onOpenChange} {...properties}>
            <DialogContent
                className={cn("max-w-md", classNames?.dialog?.content)}
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                }}
            >
                <DialogHeader className={classNames?.dialog?.header}>
                    <DialogTitle className={cn("text-lg md:text-xl", classNames?.title)}>{t`Backup Codes`}</DialogTitle>

                    <DialogDescription className={cn("text-xs md:text-sm", classNames?.description)}>
                        {t`Save these backup codes in a safe place. You can use them to access your account if you lose your two-factor authentication device.`}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4">
                    <div className="bg-muted rounded-lg p-4">
                        <div className="grid grid-cols-1 gap-2 font-mono text-sm">
                            {backupCodes.map((code) => (
                                <div className="text-center" key={code}>
                                    {code}
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="text-muted-foreground text-sm">{t`Each code can only be used once. Keep them secure and treat them like passwords.`}</div>
                </div>

                <DialogFooter className={cn("flex-col gap-2 sm:flex-row", classNames?.dialog?.footer)}>
                    <Button
                        className={cn("w-full sm:w-auto", classNames?.button, classNames?.outlineButton)}
                        onClick={handleDownload}
                        type="button"
                        variant="outline"
                    >
                        <DownloadIcon className="h-4 w-4" />
                        {t`Download`}
                    </Button>

                    <Button
                        className={cn("w-full sm:w-auto", classNames?.button, classNames?.outlineButton)}
                        disabled={copied}
                        onClick={handleCopy}
                        type="button"
                        variant="outline"
                    >
                        {copied ? (
                            <>
                                <CheckIcon className="h-4 w-4" />
                                {t`Copied!`}
                            </>
                        ) : (
                            <>
                                <CopyIcon className="h-4 w-4" />
                                {t`Copy`}
                            </>
                        )}
                    </Button>

                    <Button
                        className={cn("w-full sm:w-auto", classNames?.button, classNames?.primaryButton)}
                        onClick={() => onOpenChange?.(false)}
                        type="button"
                    >
                        {t`Done`}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
};

export default BackupCodesDialog;
