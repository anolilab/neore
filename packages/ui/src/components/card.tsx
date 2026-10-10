import cn from "@ui/utils/cn";
import * as React from "react";

import { HeadingLevelProvider } from "./heading";
import type { HeadingLevel } from "./heading-context";
import { nextHeadingLevel, useHeadingLevel } from "./heading-context";

/** The level of THIS card's title; `undefined` outside an outline, where the title stays a `div`. */
const CardTitleLevelContext = React.createContext<HeadingLevel | undefined>(undefined);

/**
 * Inside a heading outline (`HeadingLevelProvider`, see `./heading`) a card is
 * a section: its `CardTitle` takes the outline's current level and everything
 * in the card — a nested card's title included — one level deeper. Outside one
 * it is a box and its title a `div`, as before.
 *
 * A card WITHOUT a title still opens a level, so a titled card nested in an
 * untitled one skips a level — wrap such content in `HeadingLevelProvider`
 * with the outer level instead.
 */
const Card = ({ children, className, size = "default", ...props }: React.ComponentProps<"div"> & { size?: "default" | "sm" }) => {
    const level = useHeadingLevel();

    return (
        <div
            className={cn(
                "ring-foreground/10 bg-card text-card-foreground group/card flex flex-col gap-4 overflow-hidden rounded-lg py-4 text-xs/relaxed ring-1 has-[>img:first-child]:pt-0 data-[size=sm]:gap-3 data-[size=sm]:py-3 *:[img:first-child]:rounded-t-lg *:[img:last-child]:rounded-b-lg",
                className,
            )}
            data-size={size}
            data-slot="card"
            {...props}
        >
            <CardTitleLevelContext value={level}>
                <HeadingLevelProvider level={level === undefined ? undefined : nextHeadingLevel(level)}>{children}</HeadingLevelProvider>
            </CardTitleLevelContext>
        </div>
    );
};

const CardHeader = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "group/card-header @container/card-header grid auto-rows-min items-start gap-1 rounded-t-lg px-4 group-data-[size=sm]/card:px-3 has-data-[slot=card-action]:grid-cols-[1fr_auto] has-data-[slot=card-description]:grid-rows-[auto_auto] [.border-b]:pb-4 group-data-[size=sm]/card:[.border-b]:pb-3",
            className,
        )}
        data-slot="card-header"
        {...props}
    />
);

/** A `div` outside a heading outline; inside one, the heading at its card's level (see `Card`). */
const CardTitle = ({ className, ...props }: React.ComponentProps<"div">) => {
    const level = React.use(CardTitleLevelContext);

    if (level === undefined) {
        return <div className={cn("text-sm font-medium", className)} data-slot="card-title" {...props} />;
    }

    const Tag = `h${level}` as const;

    return <Tag className={cn("text-sm font-medium", className)} data-slot="card-title" {...(props as React.ComponentProps<"h2">)} />;
};

/**
 * An unstyled heading at its card's level, for a card that names itself
 * somewhere other than a `CardTitle` (a list row's name inside `CardContent`).
 * Outside an outline it renders `fallbackLevel`.
 */
const CardHeading = ({ fallbackLevel = 3, ...props }: React.ComponentProps<"h2"> & { fallbackLevel?: HeadingLevel }) => {
    const Tag = `h${React.use(CardTitleLevelContext) ?? fallbackLevel}` as const;

    return <Tag {...props} />;
};

const CardDescription = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("text-muted-foreground text-xs/relaxed", className)} data-slot="card-description" {...props} />
);

const CardAction = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("col-start-2 row-span-2 row-start-1 self-start justify-self-end", className)} data-slot="card-action" {...props} />
);

const CardContent = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div className={cn("px-4 group-data-[size=sm]/card:px-3", className)} data-slot="card-content" {...props} />
);

const CardFooter = ({ className, ...props }: React.ComponentProps<"div">) => (
    <div
        className={cn(
            "flex items-center rounded-b-lg px-4 group-data-[size=sm]/card:px-3 [.border-t]:pt-4 group-data-[size=sm]/card:[.border-t]:pt-3",
            className,
        )}
        data-slot="card-footer"
        {...props}
    />
);

export { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardHeading, CardTitle };
