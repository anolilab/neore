"use client";

import { useLingui } from "@lingui/react/macro";
import cn from "@neore/ui/utils/cn";
import clsx from "clsx";
import { ArrowRight } from "lucide-react";
import type { FC } from "react";
import { useState } from "react";

import Neore from "@/assets/logo/neore.svg?react";
import { LinkButton } from "@/components/link-button";
import useIsAnonymous from "@/features/auth/hooks/use-is-anonymous";

export type NavTheme = "dark" | "light";

const Navbar: FC<{ theme?: NavTheme }> = ({ theme = "dark" }) => {
    const { t } = useLingui();
    const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
    const isDark = theme === "dark";
    const { isAnonymous, user } = useIsAnonymous();
    const isAuthenticated = !!user && !isAnonymous;

    const toggleMobileMenu = () => {
        setMobileMenuOpen((previous) => !previous);
    };

    return (
        <header
            className={cn(
                "sticky top-0 z-50 w-full border-b transition-colors duration-300",
                isDark ? "bg-background border-white/10" : "border-brand-silver bg-brand-white",
            )}
        >
            <div
                className={cn(
                    "container mx-auto flex h-14 items-center justify-between border-x px-4 transition-colors duration-300 sm:px-6 lg:px-10",
                    isDark ? "border-white/10" : "border-brand-silver",
                )}
            >
                <a className="flex items-center gap-2.5" href="/#hero" title={t`Neore - AI Text & Video & Audio & Image & Documents Generation Platform`}>
                    <Neore className={clsx("size-10", isDark ? "fill-white" : "fill-brand-obsidian")} />
                    <span className="sr-only">neore</span>
                </a>

                {/* Desktop Navigation */}
                <nav className="hidden items-center gap-1 md:flex">
                    <a
                        className={cn(
                            "px-3 py-1.5 text-sm font-medium transition-colors",
                            isDark ? "text-white/60 hover:text-white" : "text-brand-graphite hover:text-brand-obsidian",
                        )}
                        href="/#models"
                    >
                        {t`Models`}
                    </a>
                    <a
                        className={cn(
                            "px-3 py-1.5 text-sm font-medium transition-colors",
                            isDark ? "text-white/60 hover:text-white" : "text-brand-graphite hover:text-brand-obsidian",
                        )}
                        href="/#features"
                    >
                        {t`Features`}
                    </a>
                    <a
                        className={cn(
                            "px-3 py-1.5 text-sm font-medium transition-colors",
                            isDark ? "text-white/60 hover:text-white" : "text-brand-graphite hover:text-brand-obsidian",
                        )}
                        href="/#pricing"
                    >
                        {t`Pricing`}
                    </a>
                    <a
                        className={cn(
                            "px-3 py-1.5 text-sm font-medium transition-colors",
                            isDark ? "text-white/60 hover:text-white" : "text-brand-graphite hover:text-brand-obsidian",
                        )}
                        href="/#faq"
                    >
                        {t`FAQ`}
                    </a>
                </nav>

                {/* Desktop CTA */}
                <div className="hidden items-center gap-3 md:flex">
                    {isAuthenticated ? (
                        <LinkButton size="marketing" to="/chat" variant="marketing">
                            {t`Go to chat`}
                        </LinkButton>
                    ) : (
                        <>
                            <LinkButton size="marketing" to="/auth/sign-in" variant="marketing-ghost">
                                {t`Login`}
                            </LinkButton>
                            <LinkButton size="marketing" to="/chat" variant="marketing">
                                {t`Try it free`}
                            </LinkButton>
                        </>
                    )}
                </div>

                {/* Mobile menu button */}
                <button
                    aria-controls="mobile-menu"
                    aria-expanded={mobileMenuOpen}
                    aria-label={t`Toggle menu`}
                    className={cn(
                        "focus-visible:ring-ring/50 inline-flex size-9 shrink-0 items-center justify-center transition-all outline-none focus-visible:ring-2 md:hidden",
                        isDark ? "text-white" : "text-brand-obsidian",
                    )}
                    onClick={toggleMobileMenu}
                    type="button"
                >
                    <div className="relative size-4">
                        <span
                            className={cn(
                                "absolute left-0 block h-0.5 w-full transition-all duration-150",
                                isDark ? "bg-white" : "bg-brand-obsidian",
                                mobileMenuOpen ? "top-[0.45rem] rotate-45" : "top-[0.1rem]",
                            )}
                        />
                        <span
                            className={cn(
                                "absolute top-[0.45rem] left-0 block h-0.5 w-full transition-opacity duration-150",
                                isDark ? "bg-white" : "bg-brand-obsidian",
                                mobileMenuOpen && "opacity-0",
                            )}
                        />
                        <span
                            className={cn(
                                "absolute left-0 block h-0.5 w-full transition-all duration-150",
                                isDark ? "bg-white" : "bg-brand-obsidian",
                                mobileMenuOpen ? "top-[0.45rem] -rotate-45" : "top-[0.8rem]",
                            )}
                        />
                    </div>
                    <span className="sr-only">{t`Toggle Menu`}</span>
                </button>
            </div>

            {/* Mobile menu — drops within the editorial grid lines */}
            {mobileMenuOpen && (
                <div className={cn("border-t md:hidden", isDark ? "border-white/10" : "border-brand-silver")} id="mobile-menu">
                    <div className={cn("container mx-auto border-x", isDark ? "border-white/10" : "border-brand-silver")}>
                        <nav className="flex flex-col">
                            <a
                                className={cn(
                                    "border-b px-4 py-3 text-sm font-medium transition-colors sm:px-6",
                                    isDark ? "border-white/10 text-white hover:bg-white/5" : "border-brand-silver text-brand-obsidian hover:bg-brand-frost",
                                )}
                                href="/#models"
                            >
                                {t`Models`}
                            </a>
                            <a
                                className={cn(
                                    "border-b px-4 py-3 text-sm font-medium transition-colors sm:px-6",
                                    isDark ? "border-white/10 text-white hover:bg-white/5" : "border-brand-silver text-brand-obsidian hover:bg-brand-frost",
                                )}
                                href="/#features"
                            >
                                {t`Features`}
                            </a>
                            <a
                                className={cn(
                                    "border-b px-4 py-3 text-sm font-medium transition-colors sm:px-6",
                                    isDark ? "border-white/10 text-white hover:bg-white/5" : "border-brand-silver text-brand-obsidian hover:bg-brand-frost",
                                )}
                                href="/#pricing"
                            >
                                {t`Pricing`}
                            </a>
                            <a
                                className={cn(
                                    "border-b px-4 py-3 text-sm font-medium transition-colors sm:px-6",
                                    isDark ? "border-white/10 text-white hover:bg-white/5" : "border-brand-silver text-brand-obsidian hover:bg-brand-frost",
                                )}
                                href="/#faq"
                            >
                                {t`FAQ`}
                            </a>
                            <div className="flex flex-col gap-2 px-4 py-4 sm:px-6">
                                {!isAuthenticated && (
                                    <LinkButton
                                        className={cn("w-full rounded-none", isDark ? "border-white/20 text-white" : "border-brand-silver text-brand-obsidian")}
                                        size="sm"
                                        to="/auth/sign-in"
                                        variant="outline"
                                    >
                                        {t`Login`}
                                    </LinkButton>
                                )}
                                <LinkButton className="w-full" size="marketing" to="/chat" variant="marketing">
                                    {isAuthenticated ? t`Go to chat` : t`Get Access`}
                                    <ArrowRight className="ml-1.5 size-3.5" />
                                </LinkButton>
                            </div>
                        </nav>
                    </div>
                </div>
            )}
        </header>
    );
};

export default Navbar;
