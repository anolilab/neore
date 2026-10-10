"use client";

import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import { ArrowLeft, ArrowRight, CheckCircle2, Image, MessageSquare, Video } from "lucide-react";
import { motion } from "motion/react";

import { LinkButton } from "@/components/link-button";
import { localizeModelDescription } from "@/lib/model-descriptions";

import type { MarketingModel } from "../data/models-data";
import { IMAGE_MODELS, TEXT_MODELS, VIDEO_MODELS } from "../data/models-data";
import LandingFooter from "./landing-footer";
import Navbar from "./navbar-menu";
import SectionSeperator from "./section-seperator";

// ---------------------------------------------------------------------------
// Animation
// ---------------------------------------------------------------------------

const fadeIn = {
    hidden: { opacity: 0, y: 16 },
    visible: { opacity: 1, transition: { duration: 0.5 }, y: 0 },
};

// ---------------------------------------------------------------------------
// Tier configuration
// ---------------------------------------------------------------------------

const TIER_CONFIG = {
    budget: { className: "border-amber-400/30 bg-amber-400/10 text-amber-400", label: msg`Budget` },
    fast: { className: "border-sky-400/30 bg-sky-400/10 text-sky-400", label: msg`Fast` },
    frontier: { className: "border-primary/30 bg-primary/10 text-primary", label: msg`Frontier` },
    "high-quality": { className: "border-emerald-400/30 bg-emerald-400/10 text-emerald-400", label: msg`High Quality` },
    medium: { className: "border-white/20 bg-white/5 text-white/50", label: msg`Standard` },
} satisfies Record<MarketingModel["tier"], { className: string; label: MessageDescriptor }>;

// ---------------------------------------------------------------------------
// Related models (same mode, different model)
// ---------------------------------------------------------------------------

const getRelated = (model: MarketingModel, limit = 8): MarketingModel[] => {
    let pool = TEXT_MODELS;

    if (model.mode === "image") {
        pool = IMAGE_MODELS;
    } else if (model.mode === "video") {
        pool = VIDEO_MODELS;
    }

    return pool.filter((m) => m.slug !== model.slug).slice(0, limit);
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface ModelDetailPageProps {
    model: MarketingModel;
}

const ModelDetailPage = ({ model }: ModelDetailPageProps) => {
    const { i18n, t } = useLingui();
    const related = getRelated(model);
    const tier = TIER_CONFIG[model.tier];
    const totalModels = IMAGE_MODELS.length + VIDEO_MODELS.length + TEXT_MODELS.length;

    // One branch per mode instead of a chain of nested ternaries at each use site.
    //
    // The copy lives in an object rather than in loose `const`s because
    // `comparisonNoun` is interpolated into a Lingui message: a bare identifier
    // would be extracted as a NAMED placeholder and orphan the nine existing
    // `{1}` catalog entries, while a member expression keeps the positional one.
    let ModeIcon = MessageSquare;
    let modeCopy = {
        comparisonNoun: "text",
        heading: t`Text Generation`,
        relatedHeading: t`Other text models`,
        subtitle: t`Text generation model`,
    };

    if (model.mode === "image") {
        ModeIcon = Image;
        modeCopy = {
            comparisonNoun: "image generation",
            heading: t`Image Generation`,
            relatedHeading: t`Other image models`,
            subtitle: t`Image generation model`,
        };
    } else if (model.mode === "video") {
        ModeIcon = Video;
        modeCopy = {
            comparisonNoun: "video generation",
            heading: t`Video Generation`,
            relatedHeading: t`Other video models`,
            subtitle: t`Video generation model`,
        };
    }

    return (
        <div className="relative h-screen overflow-y-auto scroll-smooth font-mono">
            <Navbar />

            <main>
                <div data-nav-theme="dark">
                    {/* ── Hero ─────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 pt-32 pb-16 sm:pt-40 sm:pb-24 lg:px-10">
                        <SectionSeperator />
                        <motion.div animate="visible" className="max-w-2xl" initial="hidden" variants={fadeIn}>
                            {/* Breadcrumb */}
                            <div className="mb-6 flex items-center gap-2 font-mono text-xs text-white/30">
                                <a className="transition-colors hover:text-white/60" href="/models">
                                    {t`Models`}
                                </a>
                                <span>/</span>
                                <span className="text-white/50">{model.name}</span>
                            </div>

                            {/* Mode + Tier badges */}
                            <div className="mb-4 flex flex-wrap items-center gap-2">
                                <span className="text-primary inline-flex items-center gap-1.5 font-mono text-xs font-medium tracking-widest uppercase">
                                    <ModeIcon className="size-3" />
                                    {modeCopy.heading}
                                </span>
                                <span
                                    className={`inline-flex items-center rounded-full border px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider uppercase ${tier.className}`}
                                >
                                    {i18n._(tier.label)}
                                </span>
                            </div>

                            <h1 className="mb-4 text-4xl leading-tight font-bold tracking-tight sm:text-5xl md:text-6xl">{model.name}</h1>

                            <p className="mb-4 text-lg leading-relaxed text-white/60">
                                {localizeModelDescription(model.desc, (descriptor) => i18n._(descriptor))}
                            </p>

                            <p className="mb-6 text-sm text-white/30">
                                <Trans>
                                    by <span className="text-white/50">{model.provider}</span>
                                </Trans>
                                {" · "}
                                {modeCopy.subtitle}
                            </p>

                            {/* Capability tags */}
                            <div className="mb-8 flex flex-wrap gap-2">
                                {model.tags.map((tag) => (
                                    <span
                                        className="rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 font-mono text-[11px] text-white/40"
                                        key={tag.id}
                                    >
                                        {i18n._(tag)}
                                    </span>
                                ))}
                            </div>

                            <div className="flex flex-wrap gap-3">
                                <LinkButton size="marketing" to="/chat" variant="marketing">
                                    {t`Try ${model.name}`} <ArrowRight className="ml-1.5 size-3.5" />
                                </LinkButton>
                                <a className="inline-flex items-center gap-1.5 text-sm text-white/40 transition-colors hover:text-white/70" href="/models">
                                    <ArrowLeft className="size-3.5" />
                                    {t`All models`}
                                </a>
                            </div>
                        </motion.div>
                    </section>

                    {/* ── Key strengths ─────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 py-12 sm:px-6 sm:py-16 lg:px-10">
                        <SectionSeperator />
                        <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                            <p className="mb-6 font-mono text-[10px] font-medium tracking-widest text-white/30 uppercase">{t`Why ${model.name}`}</p>
                            <ul className="space-y-4">
                                {model.strengths.map((strength) => (
                                    <li className="flex items-start gap-3" key={strength.id}>
                                        <CheckCircle2 className="text-primary mt-0.5 size-4 shrink-0" />
                                        <span className="text-sm leading-relaxed text-white/70">{i18n._(strength)}</span>
                                    </li>
                                ))}
                            </ul>
                        </motion.div>
                    </section>

                    {/* ── Best for ──────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 py-12 sm:px-6 sm:py-16 lg:px-10">
                        <SectionSeperator />
                        <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                            <p className="mb-4 font-mono text-[10px] font-medium tracking-widest text-white/30 uppercase">{t`Best for`}</p>
                            <p className="max-w-xl text-sm leading-relaxed text-white/60">{i18n._(model.bestFor)}</p>
                        </motion.div>
                    </section>

                    {/* ── Why on Neore ──────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 py-12 sm:px-6 sm:py-16 lg:px-10">
                        <SectionSeperator />
                        <motion.div
                            className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between"
                            initial="hidden"
                            variants={fadeIn}
                            viewport={{ once: true }}
                            whileInView="visible"
                        >
                            <div className="max-w-lg">
                                <p className="mb-3 font-mono text-[10px] font-medium tracking-widest text-white/30 uppercase">{t`Access on Neore`}</p>
                                <p className="text-sm leading-relaxed text-white/60">
                                    {t`${model.name} is one of ${totalModels}+ AI models available on Neore — all in one workspace, one subscription. No tab-switching. No managing six accounts.`}
                                </p>
                                <p className="mt-2 text-xs text-white/30">
                                    {t`$20/mo replaces ChatGPT + Midjourney + Runway + more. Free to start — no credit card required.`}
                                </p>
                            </div>
                            <LinkButton className="shrink-0" size="marketing" to="/chat" variant="marketing">
                                {t`Try free`} <ArrowRight className="ml-1.5 size-3.5" />
                            </LinkButton>
                        </motion.div>
                    </section>

                    {/* ── FAQ ───────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 py-12 sm:px-6 sm:py-16 lg:px-10">
                        <SectionSeperator />
                        <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                            <p className="mb-8 font-mono text-[10px] font-medium tracking-widest text-white/30 uppercase">{t`FAQ`}</p>
                            <dl className="max-w-2xl space-y-8">
                                <div>
                                    <dt className="mb-2 text-sm font-medium text-white/80">{t`Is ${model.name} free to use?`}</dt>
                                    <dd className="text-sm leading-relaxed text-white/50">
                                        {t`Neore's free tier gives you 20 messages a day on a set of fast, low-cost models, no credit card required. Pro ($20/mo) unlocks ${model.name} and all ${totalModels}+ models, or bring your own API key for its provider.`}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="mb-2 text-sm font-medium text-white/80">{t`What is ${model.name} best for?`}</dt>
                                    <dd className="text-sm leading-relaxed text-white/50">{i18n._(model.bestFor)}</dd>
                                </div>
                                <div>
                                    <dt className="mb-2 text-sm font-medium text-white/80">
                                        {t`How does ${model.name} compare to other ${modeCopy.comparisonNoun} models?`}
                                    </dt>
                                    <dd className="text-sm leading-relaxed text-white/50">
                                        {t`${model.name} by ${model.provider} stands out for: ${model.strengths.map((s) => i18n._(s)).join("; ")}. On Neore you can compare it side-by-side with ${totalModels - 1} other models in the same conversation thread.`}
                                    </dd>
                                </div>
                                <div>
                                    <dt className="mb-2 text-sm font-medium text-white/80">
                                        {t`Do I need a separate ${model.provider} account to use ${model.name}?`}
                                    </dt>
                                    <dd className="text-sm leading-relaxed text-white/50">
                                        {t`No. Neore provides direct API access to ${model.name} and every other model through a single account. One login, one subscription — no need to manage accounts with ${model.provider} or any other provider separately.`}
                                    </dd>
                                </div>
                            </dl>
                        </motion.div>
                    </section>

                    {/* ── Related models ───────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 py-12 sm:px-6 sm:py-20 lg:px-10">
                        <SectionSeperator />
                        <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                            <p className="mb-6 font-mono text-[10px] font-medium tracking-widest text-white/30 uppercase">{modeCopy.relatedHeading}</p>
                            <ul className="flex flex-wrap gap-2">
                                {related.map((m) => (
                                    <li key={m.slug}>
                                        <a
                                            className="inline-block rounded-lg border border-white/[0.06] bg-white/[0.03] px-3 py-2 text-xs text-white/50 transition-colors hover:border-white/10 hover:text-white/80"
                                            href={`/models/${m.slug}`}
                                        >
                                            {m.name}
                                        </a>
                                    </li>
                                ))}
                            </ul>
                        </motion.div>
                    </section>

                    {/* ── CTA ──────────────────────────────────────────── */}
                    <section className="relative container mx-auto border-x px-4 py-16 text-center sm:px-6 sm:py-24 lg:px-10">
                        <SectionSeperator />
                        <motion.div initial="hidden" variants={fadeIn} viewport={{ once: true }} whileInView="visible">
                            <h2 className="mb-3 text-2xl font-bold sm:text-3xl">
                                <Trans>
                                    Generate with <span className="text-primary">{model.name}</span>
                                </Trans>
                            </h2>
                            <p className="mx-auto mb-8 max-w-sm text-sm text-white/40">{t`Available on Neore — free to start, no credit card required.`}</p>
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
                        {t`This platform is an independent product and is not affiliated with, endorsed by, or officially connected to ${model.provider}. We provide access to the ${model.name} model through our own interface and infrastructure. All model names, trademarks, and brand identities are the property of their respective owners.`}
                    </p>
                </div>
            </div>

            <LandingFooter />
        </div>
    );
};

export default ModelDetailPage;
