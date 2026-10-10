"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";

import { Github, Linkedin, Twitter } from "@/components/brand-icons";

import SectionSeperator from "./section-seperator";

const footerLinks = {
    company: [
        { hash: undefined, label: msg`About`, to: "/" },
        { hash: undefined, label: msg`Privacy`, to: "/datenschutz" },
        { hash: undefined, label: msg`Imprint`, to: "/impressum" },
    ],
    developers: [
        { hash: undefined, label: msg`Documentation`, to: "/gateway" },
        { hash: undefined, label: msg`API Reference`, to: "/gateway" },
        { hash: undefined, label: msg`Status Page`, to: "/gateway" },
    ],
    getStarted: [
        { hash: "pricing", label: msg`Pricing`, to: "/gateway" },
        { hash: undefined, label: msg`Get API Key`, to: "/auth/sign-up" },
    ],
    neore: [
        { hash: undefined, label: msg`Neore Chat`, to: "/" },
        { hash: "features", label: msg`Features`, to: "/gateway" },
        { hash: "providers", label: msg`Providers`, to: "/gateway" },
    ],
} as const;

const socialLinks = [
    { href: "#", icon: Linkedin, label: "LinkedIn" },
    { href: "#", icon: Twitter, label: "Twitter" },
    { href: "#", icon: Github, label: "GitHub" },
] as const;

const categoryLabels: Record<keyof typeof footerLinks, MessageDescriptor> = {
    company: msg`Company`,
    developers: msg`Developers`,
    getStarted: msg`Get Started`,
    neore: msg`Neore`,
};

const GatewayFooter: FC = () => {
    const { i18n, t } = useLingui();

    return (
        <footer className="bg-brand-obsidian text-brand-frost">
            {/* Top CTA band */}
            <div className="border-b border-white/5">
                <div className="relative container mx-auto grid grid-cols-1 items-center gap-6 border-x border-white/5 px-4 py-10 sm:px-6 md:grid-cols-2 md:py-14 lg:px-10">
                    <SectionSeperator />
                    <h2 className="text-3xl leading-tight font-light tracking-tight sm:text-5xl md:text-7xl">
                        {t`One API`}
                        <span className="mx-2 inline-block align-middle text-2xl font-extralight sm:mx-4 sm:text-4xl md:mx-6 md:text-6xl">+</span>
                        {t`Every Model`}
                    </h2>
                    <p className="text-md leading-relaxed text-white/40">
                        {t`Unified access to OpenAI, Google, Anthropic, xAI, and more. Smart routing, usage tracking, and cost optimization — built for production.`}
                    </p>
                </div>
            </div>

            {/* Main footer grid */}
            <div className="container mx-auto border-x border-white/5">
                <div className="grid grid-cols-2 border-b border-white/5 sm:grid-cols-4 lg:grid-cols-5">
                    {/* Brand column */}
                    <div className="col-span-2 border-b border-white/5 px-4 py-8 sm:col-span-4 sm:px-6 lg:col-span-1 lg:border-r lg:border-b-0 lg:px-8 lg:py-10">
                        <div className="mb-4 flex items-center gap-2.5">
                            <MessageSquare className="size-5" />
                            <span className="text-sm font-semibold tracking-widest uppercase">{t`neore`}</span>
                        </div>
                        <p className="text-xs leading-relaxed text-white/30">{t`The unified LLM gateway for modern AI applications.`}</p>

                        {/* Social icons */}
                        <div className="mt-6 flex gap-3">
                            {socialLinks.map((social) => (
                                <motion.a
                                    aria-label={social.label}
                                    className="flex size-8 items-center justify-center rounded border border-white/10 text-white/40 transition-colors hover:border-white/20 hover:text-white/70"
                                    href={social.href}
                                    key={social.label}
                                    whileHover={{ y: -2 }}
                                >
                                    <social.icon className="size-3.5" />
                                </motion.a>
                            ))}
                        </div>
                    </div>

                    {/* Link columns */}
                    {Object.entries(footerLinks).map(([category, links], colIndex) => (
                        <div
                            className={`px-4 py-8 sm:px-6 lg:px-8 lg:py-10 ${colIndex % 2 === 0 ? "" : "border-l border-white/5"} ${colIndex >= 2 ? "border-t border-white/5 sm:border-t-0" : ""} ${colIndex > 0 ? "sm:border-l sm:border-white/5" : ""}`}
                            key={category}
                        >
                            <p className="mb-4 font-mono text-[10px] font-medium tracking-widest text-white/30 uppercase">
                                {i18n._(categoryLabels[category as keyof typeof footerLinks])}
                            </p>
                            <ul className="space-y-2.5">
                                {links.map((link) => (
                                    <li key={link.label.id}>
                                        {link.hash ? (
                                            <a className="text-sm text-white/60 transition-colors hover:text-white" href={`${link.to}#${link.hash}`}>
                                                {i18n._(link.label)}
                                            </a>
                                        ) : (
                                            <Link className="text-sm text-white/60 transition-colors hover:text-white" to={link.to}>
                                                {i18n._(link.label)}
                                            </Link>
                                        )}
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ))}
                </div>

                {/* Disclaimer */}
                <div className="border-b border-white/5 px-4 py-4 sm:px-6 lg:px-8">
                    <p className="text-center font-mono text-[9px] leading-relaxed tracking-wide text-white/20">
                        {t`This platform is an independent product and is not affiliated with, endorsed by, or officially connected to any AI model provider. All model names, trademarks, and brand identities are the property of their respective owners.`}
                    </p>
                </div>

                {/* Bottom bar */}
                <div className="flex flex-col items-center justify-between gap-3 px-4 py-6 sm:flex-row sm:px-6 lg:px-8">
                    <p className="font-mono text-[10px] tracking-widest text-white/25 uppercase">
                        © {new Date().getFullYear()} Neore. {t`All rights reserved.`}
                    </p>
                    <div className="flex gap-4 font-mono text-[10px] tracking-wider text-white/25 uppercase">
                        <Link className="transition-colors hover:text-white/50" to="/datenschutz">
                            {t`Privacy`}
                        </Link>
                        <Link className="transition-colors hover:text-white/50" to="/impressum">
                            {t`Imprint`}
                        </Link>
                    </div>
                </div>

                <div aria-hidden="true" className="relative mb-3 h-86 border-y">
                    <SectionSeperator />
                </div>
            </div>
        </footer>
    );
};

export default GatewayFooter;
