"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { IconType } from "@lobehub/icons";
import AlibabaText from "@lobehub/icons/es/Alibaba/components/Text";
import AnthropicText from "@lobehub/icons/es/Anthropic/components/Text";
import ArceeText from "@lobehub/icons/es/Arcee/components/Text";
import BflText from "@lobehub/icons/es/Bfl/components/Text";
import ByteDanceText from "@lobehub/icons/es/ByteDance/components/Text";
import CohereText from "@lobehub/icons/es/Cohere/components/Text";
import DeepSeekText from "@lobehub/icons/es/DeepSeek/components/Text";
import GoogleMono from "@lobehub/icons/es/Google/components/Mono";
import HailuoText from "@lobehub/icons/es/Hailuo/components/Text";
import IdeogramText from "@lobehub/icons/es/Ideogram/components/Text";
import InceptionText from "@lobehub/icons/es/Inception/components/Text";
import KimiText from "@lobehub/icons/es/Kimi/components/Text";
import KlingText from "@lobehub/icons/es/Kling/components/Text";
import KreaText from "@lobehub/icons/es/Krea/components/Text";
import LightricksText from "@lobehub/icons/es/Lightricks/components/Text";
import LumaText from "@lobehub/icons/es/Luma/components/Text";
import MetaAIText from "@lobehub/icons/es/MetaAI/components/Text";
import MinimaxText from "@lobehub/icons/es/Minimax/components/Text";
import MistralText from "@lobehub/icons/es/Mistral/components/Text";
import NovaText from "@lobehub/icons/es/Nova/components/Text";
import OpenAIText from "@lobehub/icons/es/OpenAI/components/Text";
import QwenText from "@lobehub/icons/es/Qwen/components/Text";
import RecraftText from "@lobehub/icons/es/Recraft/components/Text";
import RunwayText from "@lobehub/icons/es/Runway/components/Text";
import StepfunText from "@lobehub/icons/es/Stepfun/components/Text";
import TencentText from "@lobehub/icons/es/Tencent/components/Text";
import VercelText from "@lobehub/icons/es/Vercel/components/Text";
import ViduText from "@lobehub/icons/es/Vidu/components/Text";
import XAIText from "@lobehub/icons/es/XAI/components/Text";
import XiaomiMiMoText from "@lobehub/icons/es/XiaomiMiMo/components/Text";
import ZAIText from "@lobehub/icons/es/ZAI/components/Text";
import type { ModelCatalogEntry } from "@neore/ai/models";
import { IMAGE_CATALOG, TEXT_CATALOG, VIDEO_CATALOG } from "@neore/ai/models";
import { Link } from "@tanstack/react-router";
import { MessageSquare } from "lucide-react";
import { motion } from "motion/react";
import type { FC } from "react";

import { Github, Linkedin, Twitter } from "@/components/brand-icons";

import SectionSeperator from "./section-seperator";

const PROVIDER_ICONS: Record<string, IconType> = {
    "01.AI": LightricksText,
    Alibaba: AlibabaText,
    Amazon: NovaText,
    Anthropic: AnthropicText,
    Arcee: ArceeText,
    "Black Forest Labs": BflText,
    ByteDance: ByteDanceText,
    Cohere: CohereText,
    DeepSeek: DeepSeekText,
    Google: GoogleMono,
    Hailuo: HailuoText,
    Ideogram: IdeogramText,
    Inception: InceptionText,
    Kling: KlingText,
    Krea: KreaText,
    Lightricks: LightricksText,
    Luma: LumaText,
    Meta: MetaAIText,
    MiniMax: MinimaxText,
    Mistral: MistralText,
    Moonshot: KimiText,
    "Moonshot AI": KimiText,
    OpenAI: OpenAIText,
    Qwen: QwenText,
    Recraft: RecraftText,
    Runway: RunwayText,
    StepFun: StepfunText,
    Tencent: TencentText,
    Vercel: VercelText,
    Vidu: ViduText,
    Wan: AlibabaText,
    xAI: XAIText,
    Xiaomi: XiaomiMiMoText,
    "Z.AI": ZAIText,
};

const groupByProvider = (models: ModelCatalogEntry[]): [string, ModelCatalogEntry[]][] => {
    const map = new Map<string, ModelCatalogEntry[]>();

    for (const model of models) {
        const group = map.get(model.provider) ?? [];

        group.push(model);
        map.set(model.provider, group);
    }

    return [...map];
};

const footerLinks = {
    company: [
        { hash: undefined, label: msg`About`, to: "/" },
        { hash: undefined, label: msg`Privacy`, to: "/datenschutz" },
        { hash: undefined, label: msg`Imprint`, to: "/impressum" },
    ],
    getStarted: [
        { hash: "pricing", label: msg`Pricing`, to: "/" },
        { hash: undefined, label: msg`Try it Now`, to: "/chat" },
    ],
    product: [
        { hash: "features", label: msg`Features`, to: "/" },
        { hash: "models", label: msg`Models`, to: "/" },
        { hash: "use-cases", label: msg`Use Cases`, to: "/" },
    ],
    resources: [
        { hash: "faq", label: msg`FAQ`, to: "/" },
        { hash: undefined, label: msg`Documentation`, to: "/" },
    ],
} as const;

const socialLinks = [
    { href: "#", icon: Linkedin, label: "LinkedIn" },
    { href: "#", icon: Twitter, label: "Twitter" },
    { href: "#", icon: Github, label: "GitHub" },
] as const;

const categoryLabels: Record<keyof typeof footerLinks, MessageDescriptor> = {
    company: msg`Company`,
    getStarted: msg`Get Started`,
    product: msg`Product`,
    resources: msg`Resources`,
};

const LandingFooter: FC = () => {
    const { i18n, t } = useLingui();

    return (
        <footer className="bg-brand-obsidian text-brand-frost">
            {/* ── Top CTA band ──────────────────────────────────── */}
            <div className="border-b border-white/5">
                <div className="relative container mx-auto grid grid-cols-1 items-center gap-6 border-x border-white/5 px-4 py-10 sm:px-6 md:grid-cols-2 md:py-14 lg:px-10">
                    <SectionSeperator />
                    <h2 className="text-3xl leading-tight font-light tracking-tight sm:text-5xl md:text-7xl">
                        {t`Artificial Intelligence`}
                        <span className="mx-2 inline-block align-middle text-2xl font-extralight sm:mx-4 sm:text-4xl md:mx-6 md:text-6xl">+</span>
                        {t`Human Creativity`}
                    </h2>
                    <p className="text-md leading-relaxed text-white/40">
                        {t`30+ AI models for chat, images, video, documents, and code. One workspace, one subscription — free to start.`}
                    </p>
                </div>
            </div>

            {/* ── Models directory ──────────────────────────────── */}
            <div className="border-b border-white/5">
                <div className="container mx-auto border-x border-white/5 px-4 py-10 sm:px-6 lg:px-10">
                    <div className="mb-6 flex items-center justify-between">
                        <p className="font-mono text-[10px] font-medium tracking-widest text-white/30 uppercase">{t`Models`}</p>
                        <a className="font-mono text-[10px] tracking-widest text-white/30 uppercase transition-colors hover:text-white/60" href="/models">
                            {t`View all →`}
                        </a>
                    </div>
                    <div className="grid grid-cols-1 gap-8 sm:grid-cols-3">
                        {[
                            { label: t`Text`, models: TEXT_CATALOG },
                            { label: t`Image`, models: IMAGE_CATALOG },
                            { label: t`Video`, models: VIDEO_CATALOG },
                        ].map(({ label, models }) => (
                            <div key={label}>
                                <p className="mb-4 text-[10px] font-medium tracking-widest text-white/20 uppercase">{label}</p>
                                <div className="space-y-4">
                                    {groupByProvider(models).map(([provider, providerModels]) => {
                                        const Icon = PROVIDER_ICONS[provider];

                                        return (
                                            <div key={provider}>
                                                <div className="mb-1.5">
                                                    {Icon ? (
                                                        <Icon className="text-white/25" size={16} />
                                                    ) : (
                                                        <span className="text-[9px] font-medium tracking-wider text-white/20 uppercase">{provider}</span>
                                                    )}
                                                </div>
                                                <ul className="flex flex-wrap gap-x-3 gap-y-1">
                                                    {providerModels.map((model) => (
                                                        <li key={model.slug}>
                                                            <a
                                                                className="text-xs text-white/40 transition-colors hover:text-white/70"
                                                                href={`/models/${model.slug}`}
                                                            >
                                                                {model.name}
                                                            </a>
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            </div>

            {/* ── Main footer grid ──────────────────────────────── */}
            <div className="container mx-auto border-x border-white/5">
                <div className="grid grid-cols-2 border-b border-white/5 sm:grid-cols-4 lg:grid-cols-5">
                    {/* Brand column */}
                    <div className="col-span-2 border-b border-white/5 px-4 py-8 sm:col-span-4 sm:px-6 lg:col-span-1 lg:border-r lg:border-b-0 lg:px-8 lg:py-10">
                        <div className="mb-4 flex items-center gap-2.5">
                            <MessageSquare className="size-5" />
                            <span className="text-sm font-semibold tracking-widest uppercase">{t`neore`}</span>
                        </div>

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
                                            <a className="text-sm text-white/60 transition-colors hover:text-white" href={`#${link.hash}`}>
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

                {/* ── Disclaimer ─────────────────────────────────── */}
                <div className="border-b border-white/5 px-4 py-4 sm:px-6 lg:px-8">
                    <p className="text-center font-mono text-[9px] leading-relaxed tracking-wide text-white/20">
                        {t`This platform is an independent product and is not affiliated with, endorsed by, or officially connected to any AI model provider. All model names, trademarks, and brand identities are the property of their respective owners.`}
                    </p>
                </div>

                {/* ── Bottom bar ─────────────────────────────────── */}
                <div className="flex flex-col items-center justify-between gap-3 px-4 py-6 sm:flex-row sm:px-6 lg:px-8">
                    <p className="font-mono text-[10px] tracking-widest text-white/25 uppercase">
                        © {new Date().getFullYear()} Neore. {t`All rights reserved.`}
                    </p>
                    <div className="flex gap-4 font-mono text-[10px] tracking-wider text-white/25 uppercase">
                        <Link className="transition-colors hover:text-white/50" to="/datenschutz">{t`Privacy`}</Link>
                        <Link className="transition-colors hover:text-white/50" to="/impressum">{t`Imprint`}</Link>
                    </div>
                </div>

                <div aria-hidden="true" className="relative mb-3 h-86 border-y">
                    <SectionSeperator />
                </div>
            </div>
        </footer>
    );
};

export default LandingFooter;
