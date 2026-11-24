"use client";

import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import { saveFromUrl } from "@ui/utils/save-from-url";
import { Download } from "lucide-react";
import type { FC } from "react";

export interface SaveFileButtonProps {
    className?: string;
    /** The saved file's name when `filename` is not given (see `saveName`). */
    fallbackName?: string;
    /** The file's name. The saved file keeps this name. */
    filename?: string;
    /** The button's full accessible name, built by a caller whose name is more than the file's (a numbered gallery tile). */
    label?: string;
    url: string;
}

/**
 * An icon-only button that saves the file at `url` through `saveFromUrl`, the app's one save path. Its accessible name
 * is "Download <label>", or the file's name when no label is given, so a row of them tells a screen reader which file
 * each saves.
 */
const SaveFileButton: FC<SaveFileButtonProps> = ({ className, fallbackName, filename, label, url }) => {
    const { t } = useLingui();
    const text = label ?? (filename ? t`Download ${filename}` : t`Download`);

    return (
        <Button
            aria-label={text}
            className={className}
            onClick={() => {
                // It does not reject: a failed fetch falls back to opening the URL.
                saveFromUrl(url, filename, fallbackName).catch(() => undefined);
            }}
            size="icon-sm"
            type="button"
            variant="ghost"
        >
            <Download aria-hidden="true" className="size-4" />
        </Button>
    );
};

SaveFileButton.displayName = "SaveFileButton";

export default SaveFileButton;
