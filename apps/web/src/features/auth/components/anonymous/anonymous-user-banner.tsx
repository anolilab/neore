"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import type { FC } from "react";

import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";

const AnonymousUserBanner: FC<{
    classNames?: {
        root?: string;
    };
}> = ({ classNames }) => {
    const { isAnonymous } = useIsAnonymous();
    const { t } = useLingui();

    if (!isAnonymous) {
        return null;
    }

    return (
        <div className={cn("absolute -top-px right-0 left-0 mx-auto flex h-12.5 w-78 flex-row overflow-hidden text-sm", classNames?.root)}>
            <div
                className="relative -mr-2 size-13.75"
                style={{
                    clipPath: "inset(0px 0px 0px 0px)",
                }}
            >
                <div
                    className="ease-snappy group pointer-events-none absolute top-0 w-full origin-top transition-shadow"
                    style={{
                        boxShadow: "10px -10px 8px 2px var(--color-site-header-background)",
                    }}
                >
                    <svg
                        className="absolute origin-top-left skew-x-30 overflow-visible"
                        version="1.1"
                        viewBox="0 0 50 32"
                        xmlns="http://www.w3.org/2000/svg"
                        xmlnsXlink="http://www.w3.org/1999/xlink"
                        xmlSpace="preserve"
                    >
                        <path
                            className="fill-background dark:fill-sidebar shadow-sm dark:shadow-none"
                            d="M0,0c5.9,0,10.7,4.8,10.7,10.7v10.7c0,5.9,4.8,10.7,10.7,10.7H128V0"
                            shapeRendering="optimizeQuality"
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>
                </div>
            </div>
            <span className="bg-background text-foreground pointer-events-none relative flex h-[35px] items-center justify-center px-2 dark:text-white">{t`You're using a guest account.`}</span>
            <div
                className="relative -ml-2 size-[55px]"
                style={{
                    clipPath: "inset(0px 0px 0px 0px)",
                }}
            >
                <div
                    className="ease-snappy group pointer-events-none absolute top-0 w-full origin-top transition-shadow"
                    style={{
                        boxShadow: "-10px -10px 8px 2px var(--color-site-header-background)",
                    }}
                >
                    <svg
                        className="absolute origin-top-right skew-x-[-30deg] overflow-visible"
                        version="1.1"
                        viewBox="0 0 50 32"
                        xmlns="http://www.w3.org/2000/svg"
                        xmlnsXlink="http://www.w3.org/1999/xlink"
                        xmlSpace="preserve"
                    >
                        <path
                            className="fill-background dark:fill-sidebar shadow-sm dark:shadow-none"
                            d="M0,0c5.9,0,10.7,4.8,10.7,10.7v10.7c0,5.9,4.8,10.7,10.7,10.7H128V0"
                            shapeRendering="optimizeQuality"
                            transform="scale(-1, 1) translate(-50, 0)"
                            vectorEffect="non-scaling-stroke"
                        />
                    </svg>
                </div>
            </div>
        </div>
    );
};

export default AnonymousUserBanner;
