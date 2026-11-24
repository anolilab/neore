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
    /** The file's name. The button is named "Download <filename>", and the saved file keeps this name. */
    filename?: string;
    url: string;
}

/**
 * An icon-only button that saves the file at `url` through `saveFromUrl`, the app's one save path. Its accessible name
 * is the file's name, so a row of them (one per generated image) tells a screen reader which file each saves.
 */
const SaveFileButton: FC<SaveFileButtonProps> = ({ className, fallbackName, filename, url }) => {
    const { t } = useLingui();
    const label = filename ? t`Download ${filename}` : t`Download`;

    return (
        <Button
            aria-label={label}
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
