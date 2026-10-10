"use client";

import { Trans, useLingui } from "@lingui/react/macro";
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
import HunyuanText from "@lobehub/icons/es/Hunyuan/components/Text";
import IdeogramText from "@lobehub/icons/es/Ideogram/components/Text";
import InceptionText from "@lobehub/icons/es/Inception/components/Text";
import KimiText from "@lobehub/icons/es/Kimi/components/Text";
import KlingText from "@lobehub/icons/es/Kling/components/Text";
import LightricksText from "@lobehub/icons/es/Lightricks/components/Text";
import LumaText from "@lobehub/icons/es/Luma/components/Text";
import MetaAIText from "@lobehub/icons/es/MetaAI/components/Text";
import MinimaxText from "@lobehub/icons/es/Minimax/components/Text";
import MistralText from "@lobehub/icons/es/Mistral/components/Text";
import OpenAIText from "@lobehub/icons/es/OpenAI/components/Text";
import QwenText from "@lobehub/icons/es/Qwen/components/Text";
import RecraftText from "@lobehub/icons/es/Recraft/components/Text";
import RunwayText from "@lobehub/icons/es/Runway/components/Text";
import StepfunText from "@lobehub/icons/es/Stepfun/components/Text";
import ViduText from "@lobehub/icons/es/Vidu/components/Text";
import XAIText from "@lobehub/icons/es/XAI/components/Text";
import ZAIText from "@lobehub/icons/es/ZAI/components/Text";
import type { ModelCatalogEntry } from "@neore/ai/models";
import { IMAGE_CATALOG, TEXT_CATALOG, VIDEO_CATALOG } from "@neore/ai/models";
import cn from "@neore/ui/utils/cn";
import { ArrowRight } from "lucide-react";
import { motion } from "motion/react";
import type { ReactNode } from "react";

import { LinkButton } from "@/components/link-button";
import { localizeModelDescription } from "@/lib/model-descriptions";

import LandingFooter from "./landing-footer";
import Navbar from "./navbar-menu";
import SectionSeperator from "./section-seperator";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

type MediaEntry = { poster?: string; src: string; type: "video" } | { src: string; type: "image" };

interface ProviderEntry {
    color?: string; // fallback gradient color when no media
    gridClass: string;
    icon?: IconType; // @lobehub/icons component
    logo?: string;
    media?: MediaEntry;
    name: string;
    /** Catalog provider keys whose models to display in this card */
    providerKeys: string[];
}

const IMAGE_PROVIDERS: ProviderEntry[] = [
    {
        gridClass: "lg:col-start-1 lg:col-end-4 lg:row-start-1 lg:row-end-2",
        icon: BflText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Black%20Forest%20Labs.png", type: "image" },
        name: "Black Forest Labs",
        providerKeys: ["Black Forest Labs", "Krea"],
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-1 lg:row-end-3",
        icon: GoogleMono,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Image(3).png", type: "image" },
        name: "Google",
        providerKeys: ["Google"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-2 lg:row-end-3",
        icon: OpenAIText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Stack.png", type: "image" },
        name: "OpenAI",
        providerKeys: ["OpenAI"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-4 lg:row-start-2 lg:row-end-3",
        icon: ByteDanceText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/bytedance-poster.png", type: "image" },
        name: "ByteDance",
        providerKeys: ["ByteDance"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-3 lg:row-end-4",
        icon: IdeogramText,
        name: "Ideogram",
        providerKeys: ["Ideogram"],
    },
    {
        gridClass: "lg:col-start-2 lg:col-end-3 lg:row-start-3 lg:row-end-4",
        icon: KlingText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/kling-poster.png", type: "image" },
        name: "Kling",
        providerKeys: ["Kling"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-4 lg:row-start-3 lg:row-end-4",
        icon: RecraftText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Recraft.png", type: "image" },
        name: "Recraft",
        providerKeys: ["Recraft"],
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-3 lg:row-end-4",
        icon: RunwayText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/runway-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/runway.webm/ik-video.mp4",
            type: "video",
        },
        name: "Runway",
        providerKeys: ["Runway"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-4 lg:row-end-5",
        icon: QwenText,
        name: "Qwen",
        providerKeys: ["Qwen"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-4 lg:row-end-5",
        icon: AlibabaText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/wan-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/wan.webm/ik-video.mp4",
            type: "video",
        },
        name: "Wan",
        providerKeys: ["Wan"],
    },
];

const TEXT_PROVIDERS: ProviderEntry[] = [
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-1 lg:row-end-2",
        icon: AnthropicText,
        name: "Anthropic",
        providerKeys: ["Anthropic"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-1 lg:row-end-2",
        icon: OpenAIText,
        name: "OpenAI",
        providerKeys: ["OpenAI"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-2 lg:row-end-3",
        icon: GoogleMono,
        name: "Google",
        providerKeys: ["Google"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-2 lg:row-end-3",
        icon: DeepSeekText,
        name: "DeepSeek",
        providerKeys: ["DeepSeek"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-3 lg:row-end-4",
        icon: XAIText,
        name: "xAI",
        providerKeys: ["xAI"],
    },
    {
        gridClass: "lg:col-start-2 lg:col-end-3 lg:row-start-3 lg:row-end-4",
        icon: AlibabaText,
        name: "Alibaba",
        providerKeys: ["Alibaba"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-4 lg:row-start-3 lg:row-end-4",
        icon: MetaAIText,
        name: "Meta",
        providerKeys: ["Meta"],
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-3 lg:row-end-4",
        icon: KimiText,
        name: "Moonshot AI",
        providerKeys: ["Moonshot AI"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-4 lg:row-end-5",
        icon: MinimaxText,
        name: "MiniMax",
        providerKeys: ["MiniMax"],
    },
    {
        gridClass: "lg:col-start-2 lg:col-end-3 lg:row-start-4 lg:row-end-5",
        icon: ZAIText,
        name: "Z.AI",
        providerKeys: ["Z.AI"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-4 lg:row-end-5",
        icon: MistralText,
        name: "Mistral",
        providerKeys: ["Mistral"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-5 lg:row-end-6",
        icon: CohereText,
        name: "Cohere",
        providerKeys: ["Cohere"],
    },
    {
        gridClass: "lg:col-start-2 lg:col-end-3 lg:row-start-5 lg:row-end-6",
        icon: ByteDanceText,
        name: "ByteDance",
        providerKeys: ["ByteDance"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-4 lg:row-start-5 lg:row-end-6",
        icon: ArceeText,
        name: "Arcee",
        providerKeys: ["Arcee"],
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-5 lg:row-end-6",
        icon: InceptionText,
        name: "Inception",
        providerKeys: ["Inception"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-6 lg:row-end-7",
        icon: StepfunText,
        name: "StepFun",
        providerKeys: ["StepFun"],
    },
];

const VIDEO_PROVIDERS: ProviderEntry[] = [
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-1 lg:row-end-3",
        icon: KlingText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/kling-poster.png", type: "image" },
        name: "Kling",
        providerKeys: ["Kling"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-1 lg:row-end-2",
        icon: GoogleMono,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Image(3).png", type: "image" },
        name: "Google",
        providerKeys: ["Google"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-4 lg:row-start-2 lg:row-end-3",
        icon: OpenAIText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Stack.png", type: "image" },
        name: "OpenAI",
        providerKeys: ["OpenAI"],
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-2 lg:row-end-3",
        icon: RunwayText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/runway-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/runway.webm/ik-video.mp4",
            type: "video",
        },
        name: "Runway",
        providerKeys: ["Runway"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-3 lg:row-end-4",
        icon: ByteDanceText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/bytedance-poster.png", type: "image" },
        name: "ByteDance",
        providerKeys: ["ByteDance"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-5 lg:row-start-3 lg:row-end-4",
        icon: HailuoText,
        media: { src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/hailuo.avif", type: "image" },
        name: "Hailuo",
        providerKeys: ["Hailuo"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-3 lg:row-start-4 lg:row-end-5",
        icon: AlibabaText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/wan-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/wan.webm/ik-video.mp4",
            type: "video",
        },
        name: "Wan",
        providerKeys: ["Wan"],
    },
    {
        gridClass: "lg:col-start-3 lg:col-end-4 lg:row-start-4 lg:row-end-5",
        icon: LumaText,
        media: {
            poster: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/luma-poster.png",
            src: "https://ik.imagekit.io/ff5bkg98p/framer-website-assets/Videos/luma-ai.mp4",
            type: "video",
        },
        name: "Luma",
        providerKeys: ["Luma"],
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-4 lg:row-end-5",
        icon: HunyuanText,
        name: "Tencent",
        providerKeys: ["Tencent"],
    },
    {
        gridClass: "lg:col-start-1 lg:col-end-2 lg:row-start-5 lg:row-end-6",
        icon: XAIText,
        name: "xAI",
        providerKeys: ["xAI"],
    },
    {
        gridClass: "lg:col-start-2 lg:col-end-4 lg:row-start-5 lg:row-end-6",
        icon: ViduText,
        name: "Vidu",
        providerKeys: ["Vidu"],
    },
    {
        gridClass: "lg:col-start-4 lg:col-end-5 lg:row-start-5 lg:row-end-6",
        icon: LightricksText,
        name: "01.AI / Lightricks",
        providerKeys: ["01.AI", "Lightricks"],
    },
];

// ---------------------------------------------------------------------------
// Animation variants
// ---------------------------------------------------------------------------

const staggerContainer = {
    hidden: { opacity: 0 },
    visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

const scaleUp = {
    hidden: { opacity: 0, scale: 0.95 },
    visible: { opacity: 1, scale: 1 },
};

const fadeIn = {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, transition: { duration: 0.5 }, y: 0 },
};

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ProviderGridProps {
    catalog: ModelCatalogEntry[];
    providers: ProviderEntry[];
}

/** A catalog description in the reader's language (`ProviderGrid` itself renders no hooks). */
const ModelDescription = ({ description }: { description: string }) => {
    const { i18n } = useLingui();

    return <>{localizeModelDescription(description, (descriptor) => i18n._(descriptor))}</>;
};

const ProviderGrid = ({ catalog, providers }: ProviderGridProps) => (
    <motion.div
        className="container mx-auto grid grid-cols-1 border-x sm:grid-cols-2 lg:auto-rows-[200px] lg:grid-cols-4"
        initial="hidden"
        variants={staggerContainer}
        viewport={{ margin: "-80px", once: true }}
        whileInView="visible"
    >
        {providers.map((provider) => {
            const models = catalog.filter((e) => provider.providerKeys.includes(e.provider));

            let mediaBackground: ReactNode = null;

            if (provider.media?.type === "video") {
                mediaBackground = (
                    <video autoPlay className="absolute inset-0 h-full w-full object-cover" loop muted playsInline poster={provider.media.poster}>
                        <source src={provider.media.src} type="video/mp4" />
                    </video>
                );
            } else if (provider.media) {
                mediaBackground = <img alt="" className="absolute inset-0 h-full w-full object-cover" loading="lazy" src={provider.media.src} />;
            }

            let providerHeading: ReactNode;

            if (provider.icon) {
                providerHeading = <provider.icon className="text-white" size={28} />;
            } else if (provider.logo) {
                providerHeading = <img alt={provider.name} className="h-7 w-auto max-w-[180px] object-contain object-left" src={provider.logo} />;
            } else {
                providerHeading = <h3 className="text-base font-semibold text-white">{provider.name}</h3>;
            }

            return (
                <motion.div
                    className={cn("group relative min-h-[200px] overflow-hidden", provider.gridClass)}
                    key={provider.name}
                    style={!provider.media && provider.color ? { backgroundColor: provider.color } : undefined}
                    transition={{ duration: 0.5, ease: [0.25, 0.1, 0.25, 1] }}
                    variants={scaleUp}
                >
                    {mediaBackground}
                    <div className="absolute inset-0 bg-linear-to-t from-black/80 via-black/30 to-transparent" />
                    <div className="relative flex h-full flex-col justify-between p-5">
                        <div>{providerHeading}</div>
                        <div className="flex flex-wrap gap-1.5">
                            {models.map((model) => (
                                <span className="bg-brand-white/10 flex flex-col rounded-lg px-3 py-1.5 text-xs backdrop-blur-sm" key={model.slug}>
                                    <span className="font-medium text-white/90">{model.name}</span>
                                    <span className="text-[10px] text-white/50">
                                        <ModelDescription description={model.desc} />
                                    </span>
                                </span>
                            ))}
                        </div>
                    </div>
                </motion.div>
            );
        })}
    </motion.div>
);

// ---------------------------------------------------------------------------
// Page component
// ---------------------------------------------------------------------------

const ModelsPage = () => {
    const { t } = useLingui();

    return (
        <div className="relative h-screen overflow-y-auto scroll-smooth font-mono">
            <Navbar />

            <main>
                <div data-nav-theme="dark">
                    {/* ── Hero ──────────────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 pt-32 pb-16 sm:pt-40 sm:pb-24 lg:px-10">
                        <SectionSeperator />
                        <motion.div animate="visible" className="max-w-3xl" initial="hidden" variants={fadeIn}>
                            <span className="text-primary mb-4 inline-block font-mono text-xs font-medium tracking-widest uppercase">
                                {t`Text · Image · Video · AI`}
                            </span>
                            <h1 className="mb-4 text-4xl leading-tight font-bold tracking-tight sm:text-5xl md:text-6xl">
                                <Trans>
                                    Every model. <span className="text-primary">One subscription.</span>
                                </Trans>
                            </h1>
                            <p className="mb-8 max-w-2xl text-base leading-relaxed text-white/50 sm:text-lg">
                                {t`${TEXT_CATALOG.length}+ text models, ${IMAGE_CATALOG.length}+ image models, and ${VIDEO_CATALOG.length}+ video models — from Claude and GPT-5 to Flux and Veo — all included in one plan. Switch between any of them mid-conversation.`}
                            </p>
                            <div className="flex flex-wrap gap-3">
                                <LinkButton size="marketing" to="/chat" variant="marketing">
                                    {t`Try it free`} <ArrowRight className="ml-1.5 size-3.5" />
                                </LinkButton>
                            </div>
                        </motion.div>
                    </section>

                    {/* ── Text Models ──────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x" id="text-models">
                        <SectionSeperator />
                        <div className="px-4 py-12 sm:px-6 sm:py-20 lg:px-10">
                            <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                                <h2 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">{t`Text & chat`}</h2>
                                <p className="text-base text-white/50">{t`${TEXT_CATALOG.length} models across ${TEXT_PROVIDERS.length} providers`}</p>
                            </motion.div>
                        </div>
                        <ProviderGrid catalog={TEXT_CATALOG} providers={TEXT_PROVIDERS} />
                    </section>

                    {/* ── Image Models ─────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x" id="image-models">
                        <SectionSeperator />
                        <div className="px-4 py-12 sm:px-6 sm:py-20 lg:px-10">
                            <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                                <h2 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">{t`Image generation`}</h2>
                                <p className="text-base text-white/50">{t`${IMAGE_CATALOG.length} models across ${IMAGE_PROVIDERS.length} providers`}</p>
                            </motion.div>
                        </div>
                        <ProviderGrid catalog={IMAGE_CATALOG} providers={IMAGE_PROVIDERS} />
                    </section>

                    {/* ── Video Models ─────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x" id="video-models">
                        <SectionSeperator />
                        <div className="px-4 py-12 sm:px-6 sm:py-20 lg:px-10">
                            <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                                <h2 className="mb-2 text-2xl font-bold tracking-tight sm:text-3xl">{t`Video generation`}</h2>
                                <p className="text-base text-white/50">{t`${VIDEO_CATALOG.length} models across ${VIDEO_PROVIDERS.length} providers`}</p>
                            </motion.div>
                        </div>
                        <ProviderGrid catalog={VIDEO_CATALOG} providers={VIDEO_PROVIDERS} />
                    </section>

                    {/* ── CTA ──────────────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 py-16 text-center sm:px-6 sm:py-28 lg:px-10">
                        <SectionSeperator />
                        <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                            <h2 className="mb-3 text-3xl font-bold sm:text-4xl">
                                <Trans>
                                    All models. <span className="text-primary">One workspace.</span>
                                </Trans>
                            </h2>
                            <p className="mx-auto mb-8 max-w-md text-base text-white/50">{t`Start free with 20 messages a day — no credit card required.`}</p>
                            <LinkButton size="marketing" to="/chat" variant="marketing">
                                {t`Get started free`} <ArrowRight className="ml-2 size-4" />
                            </LinkButton>
                        </motion.div>
                    </section>
                </div>
            </main>

            {/* ── Disclaimer ─────────────────────────────────── */}
            <div className="bg-brand-obsidian border-t border-white/5 px-4 py-6 sm:px-6 lg:px-10">
                <div className="container mx-auto border-x border-white/5 px-4 py-4 sm:px-6 lg:px-8">
                    <p className="font-mono text-[9px] leading-relaxed tracking-wide text-white/20">
                        {t`This platform is an independent product and is not affiliated with, endorsed by, or officially connected to any AI model provider, including but not limited to Google, OpenAI, Anthropic, Meta, or Mistral. We provide access to these models through our own interface and infrastructure. All model names, trademarks, and brand identities are the property of their respective owners.`}
                    </p>
                </div>
            </div>

            <LandingFooter />
        </div>
    );
};

export default ModelsPage;
