import { useLingui } from "@lingui/react/macro";
import type { FC } from "react";

import cn from "../utils/cn";
import { useImageOpener } from "./image-open-context";

/**
 * A tool's image: a button that opens the gallery at it when the app provides one, else a plain image. The button's
 * name says what a click does; the picture inside is then decorative.
 */
export const GalleryImage: FC<{ alt: string; buttonClassName?: string; className?: string; imageKey: string; src: string }> = ({
    alt,
    buttonClassName,
    className,
    imageKey,
    src,
}) => {
    const { t } = useLingui();
    const open = useImageOpener();

    if (!open) {
        return <img alt={alt} className={className} src={src} />;
    }

    return (
        <button
            aria-label={t`Open ${alt} in the image gallery`}
            className={cn("focus-visible:ring-ring cursor-zoom-in rounded focus-visible:ring-2 focus-visible:outline-none", buttonClassName)}
            onClick={() => open(imageKey)}
            type="button"
        >
            <img alt="" className={className} src={src} />
        </button>
    );
};
