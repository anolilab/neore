import { Separator } from "@neore/ui/components/separator";
import type { FC, PropsWithChildren, ReactNode } from "react";

import BlurGradientOverlay from "@/components/blur-gradient-overlay";

const SiteHeader: FC<
    PropsWithChildren<{ anonymousUserBanner?: ReactNode; menu?: ReactNode; themeToggle?: ReactNode; title?: string; trigger?: ReactNode }>
> = ({ anonymousUserBanner, children, menu, themeToggle, title, trigger }) => (
    <>
        <header className="text-foreground relative flex h-(--header-height) w-full shrink-0 items-center gap-2 transition-[width,height] ease-linear">
            <div className="relative z-20 flex h-full w-full items-center gap-1">
                {trigger}
                <Separator className="mx-2 mt-2 data-[orientation=vertical]:h-6" orientation="vertical" />
                {title && <h1 className="text-lg font-bold">{title}</h1>}
                {children}
                <div className="grow" />
                {anonymousUserBanner}
                <div className="grow" />
                <div className="bg-sidebar dark:bg-brand-obsidian absolute top-0 right-0 flex h-(--header-height) flex-row max-sm:hidden">
                    <div className="bg-sidebar absolute -top-px left-px z-10 h-px w-20" />
                    <div
                        className="relative -mr-px size-13.75"
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
                                    stroke="var(--color-sidebar-border)"
                                    strokeLinecap="round"
                                    strokeMiterlimit={10}
                                    strokeWidth="1px"
                                    vectorEffect="non-scaling-stroke"
                                />
                            </svg>
                        </div>
                    </div>
                    <div className="bg-background border-sidebar-border relative -right-px z-10 -mt-1 flex h-(--header-height) flex-row items-center gap-1 border-b pr-2">
                        {themeToggle}
                        {menu}
                    </div>
                </div>
            </div>
        </header>
        <BlurGradientOverlay />
    </>
);

export default SiteHeader;
