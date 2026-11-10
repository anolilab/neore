import { useLingui } from "@lingui/react/macro";
import { ArrowRight } from "lucide-react";

import LandingFooter from "../components/landing-footer";
import Navbar from "../components/navbar-menu";
import { USE_CASES } from "./use-case-data";

export const UseCasesIndexPage = () => {
    const { i18n, t } = useLingui();

    return (
        <div className="min-h-screen overflow-x-hidden bg-black text-white">
            <Navbar />

            <main className="mx-auto max-w-6xl px-4 pt-32 pb-20 sm:px-6 lg:px-8">
                <header className="mx-auto mb-14 max-w-3xl text-center">
                    <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">{t`Use cases`}</h1>
                    <p className="mt-4 text-lg text-white/60">
                        {t`What Neore does day to day: work that runs on a schedule, approvals before risky actions, and the chat apps you already use.`}
                    </p>
                </header>

                <ul className="grid list-none gap-6 md:grid-cols-2 lg:grid-cols-3">
                    {USE_CASES.map((useCase) => (
                        <li key={useCase.slug}>
                            <a
                                className="group flex h-full flex-col gap-3 rounded-2xl border border-white/10 bg-white/[0.03] p-6 transition-colors hover:border-white/20 hover:bg-white/[0.06]"
                                href={`/use-cases/${useCase.slug}`}
                            >
                                <span className="text-xs font-medium tracking-wider text-white/60 uppercase">{i18n._(useCase.eyebrow)}</span>
                                <h2 className="text-lg font-semibold text-white">{i18n._(useCase.title)}</h2>
                                <p className="text-sm leading-relaxed text-white/60">{i18n._(useCase.summary)}</p>
                                <span className="mt-auto inline-flex items-center gap-2 pt-2 text-sm text-white/50 transition-colors group-hover:text-white">
                                    {t`Read the page`}
                                    <ArrowRight aria-hidden="true" className="size-4" />
                                </span>
                            </a>
                        </li>
                    ))}
                </ul>
            </main>

            <LandingFooter />
        </div>
    );
};
