"use client";

import { useLingui } from "@lingui/react/macro";
import { Badge } from "@ui/components/badge";
import type { CarouselApi } from "@ui/components/carousel";
import { Carousel, CarouselContent, CarouselItem } from "@ui/components/carousel";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@ui/components/hover-card";
import cn from "@ui/utils/cn";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { createContext, use, useCallback, useEffect, useState } from "react";

export type InlineCitationProps = ComponentProps<"span">;

export const InlineCitation = ({ className, ...props }: InlineCitationProps) => (
    <span className={cn("group inline items-center gap-1", className)} {...props} />
);

export type InlineCitationTextProps = ComponentProps<"span">;

export const InlineCitationText = ({ className, ...props }: InlineCitationTextProps) => (
    <span className={cn("group-hover:bg-accent transition-colors", className)} {...props} />
);

export type InlineCitationCardProps = ComponentProps<typeof HoverCard>;

export const InlineCitationCard = (props: InlineCitationCardProps) => <HoverCard {...props} />;

export type InlineCitationCardTriggerProps = ComponentProps<typeof Badge> & {
    sources: string[];
};

export const InlineCitationCardTrigger = ({ className, sources, ...props }: InlineCitationCardTriggerProps) => (
    <HoverCardTrigger render={<Badge className={cn("ml-1 rounded-full", className)} variant="secondary" {...props} />}>
        {sources[0] ? (
            <>
                {new URL(sources[0]).hostname} {sources.length > 1 && `+${sources.length - 1}`}
            </>
        ) : (
            "unknown"
        )}
    </HoverCardTrigger>
);

export type InlineCitationCardBodyProps = ComponentProps<"div">;

export const InlineCitationCardBody = ({ className, ...props }: InlineCitationCardBodyProps) => (
    <HoverCardContent className={cn("relative w-80 p-0", className)} {...props} />
);

const CarouselApiContext = createContext<CarouselApi | undefined>(undefined);

const useCarouselApi = () => {
    const context = use(CarouselApiContext);

    return context;
};

export type InlineCitationCarouselProps = ComponentProps<typeof Carousel>;

export const InlineCitationCarousel = ({ children, className, ...props }: InlineCitationCarouselProps) => {
    const [api, setApi] = useState<CarouselApi>();

    return (
        <CarouselApiContext value={api}>
            <Carousel className={cn("w-full", className)} setApi={setApi} {...props}>
                {children}
            </Carousel>
        </CarouselApiContext>
    );
};

export type InlineCitationCarouselContentProps = ComponentProps<"div">;

export const InlineCitationCarouselContent = (props: InlineCitationCarouselContentProps) => <CarouselContent {...props} />;

export type InlineCitationCarouselItemProps = ComponentProps<"div">;

export const InlineCitationCarouselItem = ({ className, ...props }: InlineCitationCarouselItemProps) => (
    <CarouselItem className={cn("w-full space-y-2 p-4 pl-8", className)} {...props} />
);

export type InlineCitationCarouselHeaderProps = ComponentProps<"div">;

export const InlineCitationCarouselHeader = ({ className, ...props }: InlineCitationCarouselHeaderProps) => (
    <div className={cn("bg-secondary flex items-center justify-between gap-2 rounded-t-md p-2", className)} {...props} />
);

export type InlineCitationCarouselIndexProps = ComponentProps<"div">;

export const InlineCitationCarouselIndex = ({ children, className, ...props }: InlineCitationCarouselIndexProps) => {
    const api = useCarouselApi();
    const [current, setCurrent] = useState(0);
    const [count, setCount] = useState(0);

    useEffect(() => {
        if (!api) {
            return;
        }

        setCount(api.scrollSnapList().length);
        setCurrent(api.selectedScrollSnap() + 1);

        api.on("select", () => {
            setCurrent(api.selectedScrollSnap() + 1);
        });
    }, [api]);

    return (
        <div className={cn("text-muted-foreground flex flex-1 items-center justify-end px-3 py-1 text-xs", className)} {...props}>
            {children ?? `${current}/${count}`}
        </div>
    );
};

export type InlineCitationCarouselPrevProps = ComponentProps<"button">;

export const InlineCitationCarouselPrev = ({ className, ...props }: InlineCitationCarouselPrevProps) => {
    const { t } = useLingui();
    const api = useCarouselApi();

    const handleClick = useCallback(() => {
        if (api) {
            api.scrollPrev();
        }
    }, [api]);

    return (
        <button aria-label={t`Previous`} className={cn("shrink-0", className)} onClick={handleClick} type="button" {...props}>
            <ArrowLeftIcon aria-hidden="true" className="text-muted-foreground size-4" />
        </button>
    );
};

export type InlineCitationCarouselNextProps = ComponentProps<"button">;

export const InlineCitationCarouselNext = ({ className, ...props }: InlineCitationCarouselNextProps) => {
    const { t } = useLingui();
    const api = useCarouselApi();

    const handleClick = useCallback(() => {
        if (api) {
            api.scrollNext();
        }
    }, [api]);

    return (
        <button aria-label={t`Next`} className={cn("shrink-0", className)} onClick={handleClick} type="button" {...props}>
            <ArrowRightIcon aria-hidden="true" className="text-muted-foreground size-4" />
        </button>
    );
};

export type InlineCitationSourceProps = ComponentProps<"div"> & {
    description?: string;
    title?: string;
    url?: string;
};

export const InlineCitationSource = ({ children, className, description, title, url, ...props }: InlineCitationSourceProps) => (
    <div className={cn("space-y-1", className)} {...props}>
        {title && <h4 className="truncate text-sm leading-tight font-medium">{title}</h4>}
        {url && <p className="text-muted-foreground truncate text-xs break-all">{url}</p>}
        {description && <p className="text-muted-foreground line-clamp-3 text-sm leading-relaxed">{description}</p>}
        {children}
    </div>
);

export type InlineCitationQuoteProps = ComponentProps<"blockquote">;

export const InlineCitationQuote = ({ children, className, ...props }: InlineCitationQuoteProps) => (
    <blockquote className={cn("border-muted text-muted-foreground border-l-2 pl-3 text-sm italic", className)} {...props}>
        {children}
    </blockquote>
);
