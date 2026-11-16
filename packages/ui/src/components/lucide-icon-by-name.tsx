"use client";

import type { GetLucideIcon } from "@ui/components/lucide-icon-loader";
import { getLoadedLucideIconMap, isLucideIconNameShape, loadLucideIconMap } from "@ui/components/lucide-icon-loader";
import type { LucideProps } from "lucide-react";
import type { ReactNode } from "react";
import { createElement, useEffect, useState } from "react";

interface LucideIconByNameProps extends LucideProps {
    /** Shown while the icon map loads. */
    fallback?: ReactNode;
    name: string;
    /** Shown when lucide has no icon of that name, and while the icon map cannot be loaded. */
    notFound?: ReactNode;
}

/**
 * A lucide icon picked by its kebab-case name at runtime. The first one on a page
 * loads the icon map; once it has loaded, every later icon renders at once. A name
 * that cannot be a lucide name shows `notFound` at once and loads nothing. When the
 * map fails to load, `notFound` shows too, and the load is tried again when the page
 * becomes visible again (or on a later mount).
 */
const LucideIconByName = ({ fallback = null, name, notFound = null, ...props }: LucideIconByNameProps): ReactNode => {
    const wellFormed = isLucideIconNameShape(name);
    const [getIcon, setGetIcon] = useState<GetLucideIcon | undefined>(getLoadedLucideIconMap);
    const [failed, setFailed] = useState(false);
    // Bumped to load again after a failure.
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (getIcon || !wellFormed) {
            return undefined;
        }

        let isMounted = true;

        loadLucideIconMap()
            .then((loaded: GetLucideIcon) => {
                if (isMounted) {
                    setFailed(false);
                    setGetIcon(() => loaded);
                }

                return undefined;
            })
            .catch(() => {
                if (isMounted) {
                    setFailed(true);
                }
            });

        return () => {
            isMounted = false;
        };
    }, [attempt, getIcon, wellFormed]);

    useEffect(() => {
        if (!failed) {
            return undefined;
        }

        const retry = (): void => {
            if (document.visibilityState === "visible") {
                setAttempt((count: number) => count + 1);
            }
        };

        document.addEventListener("visibilitychange", retry);

        return () => document.removeEventListener("visibilitychange", retry);
    }, [failed]);

    if (!wellFormed) {
        return notFound;
    }

    if (!getIcon) {
        return failed ? notFound : fallback;
    }

    const icon = getIcon(name);

    return icon ? createElement(icon, props) : notFound;
};

export default LucideIconByName;
