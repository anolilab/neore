import { useLingui } from "@lingui/react/macro";
import { Button } from "@ui/components/button";
import type { CarouselApi, CarouselProps } from "@ui/components/carousel-context";
import { CarouselContext } from "@ui/components/carousel-context";
import { useCarousel } from "@ui/components/use-carousel";
import cn from "@ui/utils/cn";
import useEmblaCarousel from "embla-carousel-react";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import * as React from "react";

const Carousel = ({ children, className, opts, orientation = "horizontal", plugins, setApi, ...props }: CarouselProps & React.ComponentProps<"div">) => {
    const [carouselRef, api] = useEmblaCarousel(
        {
            ...opts,
            axis: orientation === "horizontal" ? "x" : "y",
        },
        plugins,
    );
    const [canScrollPrev, setCanScrollPrev] = React.useState(false);
    const [canScrollNext, setCanScrollNext] = React.useState(false);

    const onSelect = React.useCallback((carouselApi: CarouselApi) => {
        if (!carouselApi) {
            return;
        }

        setCanScrollPrev(carouselApi.canScrollPrev());
        setCanScrollNext(carouselApi.canScrollNext());
    }, []);

    const scrollPrev = React.useCallback(() => {
        api?.scrollPrev();
    }, [api]);

    const scrollNext = React.useCallback(() => {
        api?.scrollNext();
    }, [api]);

    const handleKeyDown = React.useCallback(
        (event: React.KeyboardEvent<HTMLDivElement>) => {
            if (event.key === "ArrowLeft") {
                event.preventDefault();
                scrollPrev();
            } else if (event.key === "ArrowRight") {
                event.preventDefault();
                scrollNext();
            }
        },
        [scrollPrev, scrollNext],
    );

    React.useEffect(() => {
        if (!api || !setApi) {
            return;
        }

        setApi(api);
    }, [api, setApi]);

    React.useEffect(() => {
        if (!api) {
            return undefined;
        }

        onSelect(api);
        api.on("reInit", onSelect);
        api.on("select", onSelect);

        return () => {
            api?.off("select", onSelect);
        };
    }, [api, onSelect]);

    const contextValue = React.useMemo(() => {
        return {
            api,
            canScrollNext,
            canScrollPrev,
            carouselRef,
            opts,
            orientation: orientation || (opts?.axis === "y" ? "vertical" : "horizontal"),
            scrollNext,
            scrollPrev,
        };
    }, [api, canScrollNext, canScrollPrev, carouselRef, opts, orientation, scrollNext, scrollPrev]);

    return (
        <CarouselContext value={contextValue}>
            <div
                aria-roledescription="carousel"
                className={cn("relative", className)}
                data-slot="carousel"
                onKeyDownCapture={handleKeyDown}
                role="region"
                {...props}
            >
                {children}
            </div>
        </CarouselContext>
    );
};

const CarouselContent = ({ className, ...props }: React.ComponentProps<"div">) => {
    const { carouselRef, orientation } = useCarousel();

    return (
        <div className="overflow-hidden" data-slot="carousel-content" ref={carouselRef}>
            <div className={cn("flex", orientation === "horizontal" ? "-ml-4" : "-mt-4 flex-col", className)} {...props} />
        </div>
    );
};

const CarouselItem = ({ className, ...props }: React.ComponentProps<"div">) => {
    const { orientation } = useCarousel();

    return (
        <div
            aria-roledescription="slide"
            className={cn("min-w-0 shrink-0 grow-0 basis-full", orientation === "horizontal" ? "pl-4" : "pt-4", className)}
            data-slot="carousel-item"
            role="group"
            {...props}
        />
    );
};

const CarouselPrevious = ({ className, size = "icon-sm", variant = "outline", ...props }: React.ComponentProps<typeof Button>) => {
    const { t } = useLingui();
    const { canScrollPrev, orientation, scrollPrev } = useCarousel();

    return (
        <Button
            className={cn(
                "absolute touch-manipulation rounded-full",
                orientation === "horizontal" ? "top-1/2 -left-12 -translate-y-1/2" : "-top-12 left-1/2 -translate-x-1/2 rotate-90",
                className,
            )}
            data-slot="carousel-previous"
            disabled={!canScrollPrev}
            onClick={scrollPrev}
            size={size}
            variant={variant}
            {...props}
        >
            <ChevronLeftIcon aria-hidden="true" />
            <span className="sr-only">{t`Previous slide`}</span>
        </Button>
    );
};

const CarouselNext = ({ className, size = "icon-sm", variant = "outline", ...props }: React.ComponentProps<typeof Button>) => {
    const { t } = useLingui();
    const { canScrollNext, orientation, scrollNext } = useCarousel();

    return (
        <Button
            className={cn(
                "absolute touch-manipulation rounded-full",
                orientation === "horizontal" ? "top-1/2 -right-12 -translate-y-1/2" : "-bottom-12 left-1/2 -translate-x-1/2 rotate-90",
                className,
            )}
            data-slot="carousel-next"
            disabled={!canScrollNext}
            onClick={scrollNext}
            size={size}
            variant={variant}
            {...props}
        >
            <ChevronRightIcon aria-hidden="true" />
            <span className="sr-only">{t`Next slide`}</span>
        </Button>
    );
};

export { Carousel, CarouselContent, CarouselItem, CarouselNext, CarouselPrevious };
export type { CarouselApi } from "@ui/components/carousel-context";
