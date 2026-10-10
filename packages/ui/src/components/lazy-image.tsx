"use client";

import { AspectRatio } from "@ui/components/aspect-ratio";
import cn from "@ui/utils/cn";
import { useInView } from "motion/react";
import React from "react";

type LazyImageProps = {
    alt: string;
    aspectRatioClassName?: string;
    className?: string;
    /** URL of the fallback image. default: undefined */
    fallback?: string;
    /** Whether the image should only load when it is in view. default: false */
    inView?: boolean;
    /** The ratio of the image. */
    ratio: number;
    src: string;
};

const LazyImage = ({ alt, aspectRatioClassName, className, fallback, inView = false, ratio, src }: LazyImageProps) => {
    const ref = React.useRef<HTMLDivElement | null>(null);
    const imgRef = React.useRef<HTMLImageElement | null>(null);
    const isInView = useInView(ref, { once: true });

    const [imgSource, setImgSource] = React.useState<string | undefined>(inView ? undefined : src);
    const [isLoading, setIsLoading] = React.useState(true);

    const handleError = () => {
        if (fallback) {
            setImgSource(fallback);
        }

        setIsLoading(false);
    };

    const handleLoad = React.useCallback(() => {
        setIsLoading(false);
    }, []);

    // Load image only when inView
    React.useEffect(() => {
        if (inView && isInView && !imgSource) {
            setImgSource(src);
        }
    }, [inView, isInView, src, imgSource]);

    // Handle cached images instantly
    React.useEffect(() => {
        if (imgRef.current?.complete) {
            handleLoad();
        }
    }, [handleLoad]);

    return (
        <AspectRatio className={cn("bg-accent/30 relative size-full overflow-hidden border", aspectRatioClassName)} ratio={ratio} ref={ref}>
            {imgSource && (
                <img
                    alt={alt}
                    className={cn("size-full object-cover transition-opacity duration-500", isLoading ? "opacity-0" : "opacity-100", className)}
                    decoding="async"
                    fetchPriority={inView ? "high" : "low"}
                    loading="lazy"
                    onError={handleError}
                    onLoad={handleLoad}
                    ref={imgRef}
                    role="presentation"
                    src={imgSource}
                />
            )}
        </AspectRatio>
    );
};

export default LazyImage;
