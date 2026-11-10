import { useLingui } from "@lingui/react/macro";
import { ArrowLeft } from "lucide-react";

import LandingFooter from "../components/landing-footer";
import Navbar from "../components/navbar-menu";
import type { UseCase } from "./use-case-data";
import { USE_CASE_VISUALS } from "./use-case-visuals";
import { VisualPlayback } from "./visuals/visual-playback";

/** One use-case page: what the job is, the steps the agent takes, the controls, and one animated visual. */
export const UseCasePage = ({ useCase }: { useCase: UseCase }) => {
    const { i18n, t } = useLingui();
    const Visual = USE_CASE_VISUALS[useCase.slug];

    return (
        <div className="min-h-screen overflow-x-hidden bg-black text-white">
            <Navbar />

            <main className="mx-auto max-w-6xl px-4 pt-32 pb-20 sm:px-6 lg:px-8">
                <a className="inline-flex items-center gap-2 text-sm text-white/50 transition-colors hover:text-white" href="/use-cases">
                    <ArrowLeft aria-hidden="true" className="size-4" />
                    {t`All use cases`}
                </a>

                <header className="mt-8 max-w-3xl">
                    <p className="text-xs font-medium tracking-wider text-white/40 uppercase">{i18n._(useCase.eyebrow)}</p>
                    <h1 className="mt-3 text-4xl font-bold tracking-tight text-balance sm:text-5xl">{i18n._(useCase.title)}</h1>
                    <p className="mt-5 text-lg leading-relaxed text-white/60">{i18n._(useCase.summary)}</p>
                </header>

                <div className="mt-14 grid gap-10 lg:grid-cols-2 lg:items-start">
                    <section aria-labelledby="steps-heading">
                        <h2 className="text-xl font-semibold" id="steps-heading">
                            {t`How it works`}
                        </h2>
                        <ol className="mt-6 flex list-none flex-col gap-5">
                            {useCase.steps.map((step, index) => (
                                <li className="flex gap-4" key={i18n._(step)}>
                                    <span
                                        aria-hidden="true"
                                        className="flex size-7 shrink-0 items-center justify-center rounded-full bg-white/10 text-xs font-medium text-white/80"
                                    >
                                        {index + 1}
                                    </span>
                                    <p className="text-sm leading-relaxed text-white/70">{i18n._(step)}</p>
                                </li>
                            ))}
                        </ol>
                    </section>

                    <div className="lg:sticky lg:top-28">
                        <VisualPlayback>
                            <Visual />
                        </VisualPlayback>
                    </div>
                </div>

                <section aria-labelledby="controls-heading" className="mt-16 border-t border-white/10 pt-12">
                    <h2 className="text-xl font-semibold" id="controls-heading">
                        {t`Where you stay in control`}
                    </h2>
                    <ul className="mt-6 grid list-none gap-4 md:grid-cols-2">
                        {useCase.controls.map((control) => (
                            <li className="rounded-2xl border border-white/10 bg-white/[0.03] p-5 text-sm leading-relaxed text-white/70" key={i18n._(control)}>
                                {i18n._(control)}
                            </li>
                        ))}
                    </ul>
                </section>

                <div className="mt-16 flex flex-col items-start gap-4 rounded-2xl border border-white/10 bg-white/[0.03] p-6 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-white/70">{t`Ready to try it? Start a chat for free.`}</p>
                    <a className="rounded-full bg-white px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-white/90" href="/chat">
                        {t`Try Neore`}
                    </a>
                </div>
            </main>

            <LandingFooter />
        </div>
    );
};
