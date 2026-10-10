"use client";

import { Link } from "@tanstack/react-router";
import type { FC } from "react";

import LandingFooter from "../components/landing-footer";
import Navbar from "../components/navbar-menu";

const ImpressumPage: FC = () => (
    <div className="bg-brand-white text-brand-obsidian min-h-screen">
        <Navbar theme="light" />

        <main className="border-brand-silver container mx-auto border-x">
            <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24 lg:px-10">
                <p className="text-primary mb-4 font-mono text-xs font-medium tracking-widest uppercase">Rechtliches</p>
                <h1 className="mb-10 text-4xl font-bold tracking-tight sm:text-5xl">Impressum</h1>

                <div className="prose-brand text-brand-graphite space-y-10 leading-relaxed">
                    {/* Angaben gemäß § 5 DDG */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">Angaben gemäß § 5 DDG</h2>
                        <p>
                            Daniel Bannert
                            <br />
                            c/o Online-Impressum.de #22125
                            <br />
                            Europaring 90
                            <br />
                            53757 Sankt Augustin
                        </p>
                    </section>

                    {/* Kontakt */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">Kontakt</h2>
                        <p>
                            Telefon: +49 (0) 175 7322833
                            <br />
                            E-Mail: d.bannert@anolilab.de
                        </p>
                    </section>

                    {/* Redaktionell verantwortlich */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">Redaktionell verantwortlich</h2>
                        <p>
                            Daniel Bannert
                            <br />
                            c/o Online-Impressum.de #22125
                            <br />
                            Europaring 90
                            <br />
                            53757 Sankt Augustin
                        </p>
                    </section>

                    {/* EU-Streitschlichtung */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">EU-Streitschlichtung</h2>
                        <p>
                            Die Europäische Kommission stellt eine Plattform zur Online-Streitbeilegung (OS) bereit:{" "}
                            <a
                                className="text-primary underline underline-offset-2 hover:opacity-80"
                                href="https://ec.europa.eu/consumers/odr/"
                                rel="noopener noreferrer"
                                target="_blank"
                            >
                                https://ec.europa.eu/consumers/odr/
                            </a>
                            .
                        </p>
                        <p className="mt-2">Unsere E-Mail-Adresse finden Sie oben im Impressum.</p>
                    </section>

                    {/* Verbraucherstreitbeilegung */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">Verbraucherstreitbeilegung / Universalschlichtungsstelle</h2>
                        <p>Wir sind nicht bereit oder verpflichtet, an Streitbeilegungsverfahren vor einer Verbraucherschlichtungsstelle teilzunehmen.</p>
                    </section>

                    {/* Haftung für Inhalte */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">Haftung für Inhalte</h2>
                        <p>
                            Als Diensteanbieter sind wir gemäß § 7 Abs.1 DDG für eigene Inhalte auf diesen Seiten nach den allgemeinen Gesetzen verantwortlich.
                            Nach §§ 8 bis 10 DDG sind wir als Diensteanbieter jedoch nicht verpflichtet, übermittelte oder gespeicherte fremde Informationen zu
                            überwachen oder nach Umständen zu forschen, die auf eine rechtswidrige Tätigkeit hinweisen.
                        </p>
                        <p className="mt-2">
                            Verpflichtungen zur Entfernung oder Sperrung der Nutzung von Informationen nach den allgemeinen Gesetzen bleiben hiervon unberührt.
                            Eine diesbezügliche Haftung ist jedoch erst ab dem Zeitpunkt der Kenntnis einer konkreten Rechtsverletzung möglich. Bei
                            Bekanntwerden von entsprechenden Rechtsverletzungen werden wir diese Inhalte umgehend entfernen.
                        </p>
                    </section>

                    {/* Haftung für Links */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">Haftung für Links</h2>
                        <p>
                            Unser Angebot enthält Links zu externen Websites Dritter, auf deren Inhalte wir keinen Einfluss haben. Deshalb können wir für diese
                            fremden Inhalte auch keine Gewähr übernehmen. Für die Inhalte der verlinkten Seiten ist stets der jeweilige Anbieter oder Betreiber
                            der Seiten verantwortlich. Die verlinkten Seiten wurden zum Zeitpunkt der Verlinkung auf mögliche Rechtsverstöße überprüft.
                            Rechtswidrige Inhalte waren zum Zeitpunkt der Verlinkung nicht erkennbar.
                        </p>
                        <p className="mt-2">
                            Eine permanente inhaltliche Kontrolle der verlinkten Seiten ist jedoch ohne konkrete Anhaltspunkte einer Rechtsverletzung nicht
                            zumutbar. Bei Bekanntwerden von Rechtsverletzungen werden wir derartige Links umgehend entfernen.
                        </p>
                    </section>

                    {/* Urheberrecht */}
                    <section>
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">Urheberrecht</h2>
                        <p>
                            Die durch die Seitenbetreiber erstellten Inhalte und Werke auf diesen Seiten unterliegen dem deutschen Urheberrecht. Die
                            Vervielfältigung, Bearbeitung, Verbreitung und jede Art der Verwertung außerhalb der Grenzen des Urheberrechtes bedürfen der
                            schriftlichen Zustimmung des jeweiligen Autors bzw. Erstellers. Downloads und Kopien dieser Seite sind nur für den privaten, nicht
                            kommerziellen Gebrauch gestattet.
                        </p>
                        <p className="mt-2">
                            Soweit die Inhalte auf dieser Seite nicht vom Betreiber erstellt wurden, werden die Urheberrechte Dritter beachtet. Insbesondere
                            werden Inhalte Dritter als solche gekennzeichnet. Sollten Sie trotzdem auf eine Urheberrechtsverletzung aufmerksam werden, bitten
                            wir um einen entsprechenden Hinweis. Bei Bekanntwerden von Rechtsverletzungen werden wir derartige Inhalte umgehend entfernen.
                        </p>
                    </section>

                    {/* Navigation */}
                    <div className="border-brand-silver border-t pt-8">
                        <Link className="text-primary text-sm font-medium underline underline-offset-2 hover:opacity-80" to="/datenschutz">
                            Datenschutzerklärung ansehen →
                        </Link>
                    </div>
                </div>
            </div>
        </main>

        <LandingFooter />
    </div>
);

export default ImpressumPage;
