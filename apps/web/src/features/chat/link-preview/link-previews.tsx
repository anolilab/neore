"use client";

/**
 * The preview cards under a message (code-split; see `link-preview-slot.tsx`).
 */
import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";

import LinkPreviewCard from "./link-preview-card";

const LinkPreviews: FC<{ urls: ReadonlyArray<string> }> = ({ urls }) => {
    const { t } = useLingui();

    return (
        <ul aria-label={t`Link previews`} className="not-prose mt-2 flex list-none flex-col gap-2 p-0">
            {urls.map((url) => (
                <li className="m-0 p-0" key={url}>
                    <LinkPreviewCard url={url} />
                </li>
            ))}
        </ul>
    );
};

export default LinkPreviews;
