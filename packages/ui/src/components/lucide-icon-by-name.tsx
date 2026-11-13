"use client";

import type { GetLucideIcon } from "@ui/components/lucide-icon-loader";
import { getLoadedLucideIconMap, loadLucideIconMap } from "@ui/components/lucide-icon-loader";
import type { LucideProps } from "lucide-react";
import type { ReactNode } from "react";
import { createElement, useEffect, useState } from "react";

interface LucideIconByNameProps extends LucideProps {
    /** Shown while the icon map loads. */
    fallback?: ReactNode;
    name: string;
    /** Shown when lucide has no icon of that name. */
    notFound?: ReactNode;
}

/**
 * A lucide icon picked by its kebab-case name at runtime. The first one on a page
 * loads the icon map; once it has loaded, every later icon renders at once.
 */
const LucideIconByName = ({ fallback = null, name, notFound = null, ...props }: LucideIconByNameProps): ReactNode => {
    const [getIcon, setGetIcon] = useState<GetLucideIcon | undefined>(getLoadedLucideIconMap);

    useEffect(() => {
        if (getIcon) {
            return undefined;
        }

        let isMounted = true;

        loadLucideIconMap()
            .then((loaded: GetLucideIcon) => {
                if (isMounted) {
                    setGetIcon(() => loaded);
                }

                return undefined;
            })
            .catch(() => {
                // Keep showing the fallback; the next mount retries the load.
            });

        return () => {
            isMounted = false;
        };
    }, [getIcon]);

    if (!getIcon) {
        return fallback;
    }

    const icon = getIcon(name);

    return icon ? createElement(icon, props) : notFound;
};

export default LucideIconByName;
