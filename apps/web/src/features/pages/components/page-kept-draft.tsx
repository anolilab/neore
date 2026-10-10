"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Textarea } from "@neore/ui/components/textarea";
import { Copy } from "lucide-react";
import type { FC } from "react";
import { useId } from "react";

import { showError, showSuccess } from "@/lib/toast";

/** The user's unsaved text after they reloaded someone else's version — to copy back what they need. */
const PageKeptDraft: FC<{ markdown: string; onDismiss: () => void }> = ({ markdown, onDismiss }) => {
    const { t } = useLingui();
    const id = useId();

    return (
        <section aria-labelledby={id} className="flex h-full flex-col">
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
                <h2 className="text-sm font-semibold" id={id}>
                    {t`Your unsaved version`}
                </h2>
                <div className="flex gap-1">
                    <Button
                        aria-label={t`Copy your unsaved version`}
                        onClick={() => {
                            void (async () => {
                                try {
                                    await navigator.clipboard.writeText(markdown);
                                    showSuccess(t`Copied`);
                                } catch {
                                    showError(t`Could not copy; select the text instead`);
                                }
                            })();
                        }}
                        size="icon-sm"
                        variant="ghost"
                    >
                        <Copy aria-hidden="true" />
                    </Button>
                    <Button onClick={onDismiss} size="sm" variant="ghost">
                        {t`Discard`}
                    </Button>
                </div>
            </div>
            <p className="text-muted-foreground px-3 py-2 text-xs">{t`The page now shows the other version. Copy anything you want to keep from yours.`}</p>
            <Textarea aria-labelledby={id} className="m-3 min-h-0 flex-1 font-mono text-xs" readOnly value={markdown} />
        </section>
    );
};

export default PageKeptDraft;
