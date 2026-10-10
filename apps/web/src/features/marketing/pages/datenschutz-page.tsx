"use client";

import { Link } from "@tanstack/react-router";
import type { FC } from "react";

import LandingFooter from "../components/landing-footer";
import Navbar from "../components/navbar-menu";

const DatenschutzPage: FC = () => (
    <div className="bg-brand-white text-brand-obsidian min-h-screen">
        <Navbar theme="light" />

        <main className="border-brand-silver container mx-auto border-x">
            <div className="mx-auto max-w-3xl px-4 py-16 sm:px-6 sm:py-24 lg:px-10">
                <p className="text-primary mb-4 font-mono text-xs font-medium tracking-widest uppercase">Rechtliches</p>
                <h1 className="mb-4 text-4xl font-bold tracking-tight sm:text-5xl">Datenschutzerklärung</h1>
                <p className="text-brand-graphite mb-10 text-sm">Stand: 27. September 2026</p>

                <div className="text-brand-graphite space-y-10 leading-relaxed">
                    {/* Inhaltsübersicht */}
                    <nav className="border-brand-silver rounded-md border p-6">
                        <h2 className="text-brand-obsidian mb-3 text-sm font-semibold tracking-wider uppercase">Inhaltsübersicht</h2>
                        <ol className="list-inside list-decimal space-y-1.5 text-sm">
                            <li>
                                <a className="text-primary hover:underline" href="#verantwortlicher">
                                    Verantwortlicher
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#datenschutzbeauftragter">
                                    Datenschutzbeauftragter
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#uebersicht">
                                    Übersicht der Verarbeitungen
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#rechtsgrundlagen">
                                    Rechtsgrundlagen
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#sicherheit">
                                    Sicherheitsmaßnahmen
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#hosting">
                                    Bereitstellung des Onlineangebotes und Webhosting
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#registrierung">
                                    Registrierung, Anmeldung und Nutzerkonto
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#kontakt">
                                    Kontaktaufnahme
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#webanalyse">
                                    Webanalyse und Optimierung
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#ki">
                                    Einsatz von KI-Modellen
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#auftragsverarbeiter">
                                    Auftragsverarbeiter
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#drittland">
                                    Internationale Datentransfers
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#cookies">
                                    Cookies und Speichertechnologien
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#rechte">
                                    Rechte der betroffenen Personen
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#loeschung">
                                    Löschung von Daten
                                </a>
                            </li>
                            <li>
                                <a className="text-primary hover:underline" href="#aenderungen">
                                    Änderung dieser Datenschutzerklärung
                                </a>
                            </li>
                        </ol>
                    </nav>

                    {/* 1. Verantwortlicher */}
                    <section id="verantwortlicher">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">1. Verantwortlicher</h2>
                        <p>
                            Daniel Bannert
                            <br />
                            c/o Online-Impressum.de #22125
                            <br />
                            Europaring 90
                            <br />
                            53757 Sankt Augustin
                        </p>
                        <p className="mt-2">
                            E-Mail: d.bannert@anolilab.de
                            <br />
                            Telefon: +49 (0) 175 7322833
                        </p>
                        <p className="mt-2">
                            <Link className="text-primary underline underline-offset-2 hover:opacity-80" to="/impressum">
                                Impressum
                            </Link>
                        </p>
                    </section>

                    {/* 2. Datenschutzbeauftragter */}
                    <section id="datenschutzbeauftragter">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">2. Datenschutzbeauftragter</h2>
                        <p>
                            Daniel Bannert
                            <br />
                            E-Mail:{" "}
                            <a className="text-primary underline underline-offset-2 hover:opacity-80" href="mailto:security@neore.ai">
                                security@neore.ai
                            </a>
                        </p>
                    </section>

                    {/* 3. Übersicht der Verarbeitungen */}
                    <section id="uebersicht">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">3. Übersicht der Verarbeitungen</h2>
                        <p>
                            Die nachfolgende Übersicht fasst die Arten der verarbeiteten Daten und die Zwecke ihrer Verarbeitung zusammen und verweist auf die
                            betroffenen Personen.
                        </p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Arten der verarbeiteten Daten</h3>
                        <ul className="list-inside list-disc space-y-1 text-sm">
                            <li>Bestandsdaten (z.B. Namen, E-Mail-Adressen)</li>
                            <li>Nutzungsdaten (z.B. besuchte Seiten, Zugriffszeiten)</li>
                            <li>Inhaltsdaten (z.B. Texteingaben, Chat-Nachrichten, hochgeladene Dokumente)</li>
                            <li>Kontaktdaten (z.B. E-Mail-Adressen)</li>
                            <li>Meta-/Kommunikationsdaten (z.B. IP-Adressen, Geräte-Informationen)</li>
                            <li>Vertragsdaten (z.B. Vertragsgegenstand, Laufzeit)</li>
                            <li>Zahlungsdaten (z.B. bei kostenpflichtigen Abonnements)</li>
                        </ul>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Kategorien betroffener Personen</h3>
                        <ul className="list-inside list-disc space-y-1 text-sm">
                            <li>Nutzer (z.B. Webseitenbesucher, Nutzer von Onlinediensten)</li>
                            <li>Geschäftspartner</li>
                            <li>Interessenten</li>
                        </ul>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Zwecke der Verarbeitung</h3>
                        <ul className="list-inside list-disc space-y-1 text-sm">
                            <li>Erbringung vertraglicher Leistungen und Kundenservice</li>
                            <li>Bereitstellung des Onlineangebotes und Nutzerfreundlichkeit</li>
                            <li>Sicherheitsmaßnahmen</li>
                            <li>Reichweitenmessung und Webanalyse</li>
                            <li>Kontaktanfragen und Kommunikation</li>
                            <li>Verwaltung und Beantwortung von Anfragen</li>
                        </ul>
                    </section>

                    {/* 4. Rechtsgrundlagen */}
                    <section id="rechtsgrundlagen">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">4. Maßgebliche Rechtsgrundlagen</h2>
                        <p>Im Folgenden erhalten Sie eine Übersicht der Rechtsgrundlagen der DSGVO, auf deren Basis wir personenbezogene Daten verarbeiten:</p>
                        <ul className="mt-4 list-inside list-disc space-y-2 text-sm">
                            <li>
                                <strong>Einwilligung (Art. 6 Abs. 1 S. 1 lit. a) DSGVO)</strong> – Die betroffene Person hat ihre Einwilligung in die
                                Verarbeitung der sie betreffenden personenbezogenen Daten für einen spezifischen Zweck gegeben.
                            </li>
                            <li>
                                <strong>Vertragserfüllung (Art. 6 Abs. 1 S. 1 lit. b) DSGVO)</strong> – Die Verarbeitung ist für die Erfüllung eines Vertrags,
                                dessen Vertragspartei die betroffene Person ist, oder zur Durchführung vorvertraglicher Maßnahmen erforderlich.
                            </li>
                            <li>
                                <strong>Berechtigte Interessen (Art. 6 Abs. 1 S. 1 lit. f) DSGVO)</strong> – Die Verarbeitung ist zur Wahrung der berechtigten
                                Interessen des Verantwortlichen oder eines Dritten erforderlich, sofern nicht die Interessen oder Grundrechte der betroffenen
                                Person überwiegen.
                            </li>
                        </ul>
                    </section>

                    {/* 5. Sicherheitsmaßnahmen */}
                    <section id="sicherheit">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">5. Sicherheitsmaßnahmen</h2>
                        <p>
                            Wir treffen nach Maßgabe der gesetzlichen Vorgaben unter Berücksichtigung des Stands der Technik, der Implementierungskosten und der
                            Art, des Umfangs, der Umstände und der Zwecke der Verarbeitung sowie der unterschiedlichen Eintrittswahrscheinlichkeit und Schwere
                            des Risikos für die Rechte und Freiheiten natürlicher Personen geeignete technische und organisatorische Maßnahmen, um ein dem
                            Risiko angemessenes Schutzniveau zu gewährleisten.
                        </p>
                        <p className="mt-2">
                            Zu den Maßnahmen gehören insbesondere die Sicherung der Vertraulichkeit, Integrität und Verfügbarkeit von Daten durch Kontrolle des
                            physischen und elektronischen Zugangs zu den Daten als auch des sie betreffenden Zugriffs, der Eingabe, der Weitergabe, der
                            Sicherung der Verfügbarkeit und ihrer Trennung. Ferner haben wir Verfahren eingerichtet, die eine Wahrnehmung von
                            Betroffenenrechten, die Löschung von Daten und Reaktionen auf die Gefährdung der Daten gewährleisten.
                        </p>
                        <p className="mt-2">
                            <strong>TLS/SSL-Verschlüsselung (https):</strong> Um Ihre Daten, die über unser Onlineangebot übermittelt werden, zu schützen,
                            nutzen wir eine TLS/SSL-Verschlüsselung.
                        </p>
                    </section>

                    {/* 6. Hosting */}
                    <section id="hosting">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">6. Bereitstellung des Onlineangebotes und Webhosting</h2>
                        <p>
                            Wir verarbeiten die Daten der Nutzer, um ihnen unsere Online-Dienste zur Verfügung stellen zu können. Zu diesem Zweck verarbeiten
                            wir die IP-Adresse des Nutzers, die notwendig ist, um die Inhalte und Funktionen unserer Online-Dienste an den Browser oder das
                            Endgerät der Nutzer zu übermitteln.
                        </p>
                        <ul className="mt-4 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Verarbeitete Datenarten:</strong> Nutzungsdaten, Meta-/Kommunikationsdaten, Protokolldaten
                            </li>
                            <li>
                                <strong>Betroffene Personen:</strong> Nutzer
                            </li>
                            <li>
                                <strong>Zwecke:</strong> Bereitstellung unseres Onlineangebotes und Nutzerfreundlichkeit, Informationstechnische Infrastruktur
                            </li>
                            <li>
                                <strong>Rechtsgrundlage:</strong> Berechtigte Interessen (Art. 6 Abs. 1 S. 1 lit. f) DSGVO)
                            </li>
                        </ul>

                        <div className="border-brand-silver mt-6 rounded-md border p-4">
                            <h3 className="text-brand-obsidian mb-2 font-medium">Cloudflare</h3>
                            <p className="text-sm">
                                Wir nutzen das Content Delivery Network (CDN) und die Sicherheitsdienste von Cloudflare. Anbieter: Cloudflare, Inc., 101
                                Townsend St, San Francisco, CA 94107, USA.
                            </p>
                            <p className="mt-2 text-sm">
                                Cloudflare bietet ein weltweit verteiltes Content Delivery Network mit DNS. Dabei wird technisch der Informationstransfer
                                zwischen Ihrem Browser und unserer Webseite über das Netzwerk von Cloudflare geleitet. Cloudflare ist unter dem EU-US Data
                                Privacy Framework zertifiziert.
                            </p>
                            <p className="mt-2 text-sm">
                                Weitere Informationen:{" "}
                                <a
                                    className="text-primary underline underline-offset-2 hover:opacity-80"
                                    href="https://www.cloudflare.com/privacypolicy/"
                                    rel="noopener noreferrer"
                                    target="_blank"
                                >
                                    Datenschutzerklärung von Cloudflare
                                </a>
                            </p>
                        </div>
                    </section>

                    {/* 7. Registrierung */}
                    <section id="registrierung">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">7. Registrierung, Anmeldung und Nutzerkonto</h2>
                        <p>
                            Nutzer können ein Nutzerkonto anlegen. Im Rahmen der Registrierung werden die erforderlichen Pflichtangaben den Nutzern mitgeteilt
                            und zu Zwecken der Bereitstellung des Nutzerkontos auf Grundlage vertraglicher Pflichterfüllung verarbeitet. Zu den verarbeiteten
                            Daten gehören insbesondere die Login-Informationen (E-Mail-Adresse und Passwort).
                        </p>
                        <p className="mt-2">
                            Im Rahmen der Inanspruchnahme unserer Registrierungs- und Anmeldefunktionen sowie der Nutzung des Nutzerkontos speichern wir die
                            IP-Adresse und den Zeitpunkt der jeweiligen Nutzerhandlung. Die Speicherung erfolgt auf Grundlage unserer berechtigten Interessen
                            als auch jener der Nutzer an einem Schutz vor Missbrauch und sonstiger unbefugter Nutzung.
                        </p>
                        <ul className="mt-4 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Verarbeitete Datenarten:</strong> Bestandsdaten, Kontaktdaten, Inhaltsdaten, Meta-/Kommunikationsdaten
                            </li>
                            <li>
                                <strong>Rechtsgrundlage:</strong> Vertragserfüllung (Art. 6 Abs. 1 S. 1 lit. b) DSGVO)
                            </li>
                        </ul>
                    </section>

                    {/* 8. Kontakt */}
                    <section id="kontakt">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">8. Kontaktaufnahme</h2>
                        <p>
                            Bei der Kontaktaufnahme mit uns (z.B. per E-Mail) werden die Angaben des Anfragenden verarbeitet, soweit dies zur Beantwortung der
                            Kontaktanfragen und etwaiger angefragter Maßnahmen erforderlich ist.
                        </p>
                        <ul className="mt-4 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Verarbeitete Datenarten:</strong> Kontaktdaten, Inhaltsdaten, Nutzungsdaten, Meta-/Kommunikationsdaten
                            </li>
                            <li>
                                <strong>Rechtsgrundlage:</strong> Berechtigte Interessen (Art. 6 Abs. 1 S. 1 lit. f) DSGVO), Vertragserfüllung (Art. 6 Abs. 1 S.
                                1 lit. b) DSGVO)
                            </li>
                        </ul>
                    </section>

                    {/* 9. Webanalyse */}
                    <section id="webanalyse">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">9. Webanalyse und Optimierung</h2>
                        <p>
                            Wir setzen Webanalyse-Dienste ein, um die Nutzung unseres Onlineangebotes auswerten und verbessern zu können. Die gewonnenen
                            Statistiken dienen dazu, unser Angebot zu verbessern und für Nutzer interessanter auszugestalten.
                        </p>

                        <div className="border-brand-silver mt-6 rounded-md border p-4">
                            <h3 className="text-brand-obsidian mb-2 font-medium">PostHog</h3>
                            <p className="text-sm">
                                Wir nutzen die Analyseplattform PostHog. Anbieter: PostHog, Inc., 2261 Market Street #4008, San Francisco, CA 94114, USA.
                            </p>
                            <p className="mt-2 text-sm">
                                PostHog ermöglicht uns die Analyse des Nutzerverhaltens auf unserer Webseite, einschließlich Seitenaufrufe, Klicks und
                                Interaktionen. Wir setzen PostHog ein, um unser Angebot zu verbessern und an die Bedürfnisse unserer Nutzer anzupassen.
                            </p>
                            <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                                <li>
                                    <strong>Verarbeitete Datenarten:</strong> Nutzungsdaten, Meta-/Kommunikationsdaten (IP-Adresse, Gerätetyp, Browser)
                                </li>
                                <li>
                                    <strong>Rechtsgrundlage:</strong> Einwilligung (Art. 6 Abs. 1 S. 1 lit. a) DSGVO)
                                </li>
                            </ul>
                            <p className="mt-2 text-sm">
                                Weitere Informationen:{" "}
                                <a
                                    className="text-primary underline underline-offset-2 hover:opacity-80"
                                    href="https://posthog.com/privacy"
                                    rel="noopener noreferrer"
                                    target="_blank"
                                >
                                    Datenschutzerklärung von PostHog
                                </a>
                            </p>
                        </div>
                    </section>

                    {/* 10. KI-Modelle */}
                    <section id="ki">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">10. Einsatz von KI-Modellen</h2>
                        <p>
                            Neore Chat ermöglicht die Nutzung verschiedener KI-Modelle (z.B. von OpenAI, Google, Anthropic und weiteren Anbietern). Bei der
                            Nutzung dieser Modelle werden die von Ihnen eingegebenen Texte, hochgeladenen Dokumente und sonstige Inhaltsdaten an den jeweiligen
                            KI-Anbieter übermittelt, um die gewünschte Antwort zu generieren.
                        </p>
                        <ul className="mt-4 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Verarbeitete Datenarten:</strong> Inhaltsdaten (Texteingaben, Dokumente, Bilder)
                            </li>
                            <li>
                                <strong>Zweck:</strong> Erbringung der vertraglichen Leistung (KI-gestützte Chat-Funktionalität)
                            </li>
                            <li>
                                <strong>Rechtsgrundlage:</strong> Vertragserfüllung (Art. 6 Abs. 1 S. 1 lit. b) DSGVO)
                            </li>
                            <li>
                                <strong>Hinweis:</strong> Bitte geben Sie keine sensiblen personenbezogenen Daten (z.B. Gesundheitsdaten, Finanzdaten) in die
                                Chat-Eingabe ein, da diese an Drittanbieter übermittelt werden.
                            </li>
                        </ul>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Automatisch erstellte Gedächtniseinträge</h3>
                        <p className="text-sm">
                            Nur wenn Sie diese Funktion ausdrücklich aktivieren, wertet ein KI-Modell Ihre Unterhaltungen im Hintergrund aus und leitet daraus
                            einzelne Aussagen über Sie ab (etwa Vorlieben, wiederkehrende Arbeitsweisen oder genannte Rahmenbedingungen). Diese Einträge werden
                            mit einer Kategorie sowie einer Einschätzung zu Verlässlichkeit und Wichtigkeit gespeichert, bei widersprüchlichen Angaben
                            aktualisiert oder ersetzt und in späteren Unterhaltungen automatisch herangezogen, um Antworten auf Sie abzustimmen.
                        </p>
                        <p className="mt-2 text-sm">
                            Es handelt sich um eine automatisierte Auswertung von Inhaltsdaten, nicht um eine automatisierte Entscheidung mit rechtlicher
                            Wirkung im Sinne des Art. 22 DSGVO. Die Funktion ist standardmäßig ausgeschaltet; sie wirkt erst, wenn Sie sie in den Einstellungen
                            unter „Personalisierung“ aktivieren. Dort können Sie sie jederzeit wieder abschalten und einzelne oder alle Einträge einsehen und
                            löschen.
                        </p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Vektorindizes (Embeddings)</h3>
                        <p className="text-sm">
                            Um Ihre Unterhaltungen, hochgeladenen Dokumente und Gedächtniseinträge durchsuchbar zu machen, werden diese Inhalte in numerische
                            Repräsentationen (Embeddings) umgewandelt und in einem Vektorindex gespeichert. Aus solchen Repräsentationen lässt sich der
                            ursprüngliche Inhalt nicht wörtlich wiederherstellen, sie bleiben aber Ihrem Konto zugeordnet und werden mit dessen Löschung
                            entfernt.
                        </p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Weitere Datenquellen</h3>
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Import bestehender Chatverläufe:</strong> Laden Sie einen Export eines anderen Dienstes (z.B. ChatGPT, Claude, Gemini)
                                hoch, verarbeiten wir dessen Inhalte wie eigene Unterhaltungen. Enthält der Export Angaben über Dritte, sind Sie für deren
                                Rechtmäßigkeit verantwortlich.
                            </li>
                            <li>
                                <strong>Messenger-Anbindungen:</strong> Verbinden Sie einen Messenger (Telegram, Slack, Discord, WhatsApp, LINE, Feishu/Lark,
                                Microsoft Teams oder WeChat), werden die dort an den Bot gerichteten Nachrichten an uns übermittelt und wie Chat-Inhalte
                                verarbeitet. Die dafür nötigen Zugangsdaten speichern wir verschlüsselt. Zur Verwendung von Werkzeugen in Antworten auf solche
                                Nachrichten siehe unten.
                            </li>
                            <li>
                                <strong>Abruf von Webinhalten:</strong> Fordern Sie eine Recherche oder das Öffnen einer Adresse an, ruft unser System die
                                betreffende Seite ab. Die Betreiber der aufgerufenen Seite erhalten dabei die technischen Verbindungsdaten unseres Dienstes,
                                nicht Ihre IP-Adresse.
                            </li>
                            <li>
                                <strong>Eigene API-Schlüssel:</strong> Hinterlegen Sie eigene Zugangsschlüssel für Modellanbieter oder Werkzeuge, werden diese
                                verschlüsselt gespeichert und ausschließlich für Ihre eigenen Anfragen verwendet.
                            </li>
                        </ul>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Werkzeuge in Messenger-Antworten</h3>
                        <p className="text-sm">
                            Standardmäßig beantworten wir Nachrichten aus einer Messenger-Anbindung nur mit Text. Erst wenn Sie als Inhaber der Anbindung
                            Werkzeuge für diese Anbindung ausdrücklich freigeben, darf die Antwort die von Ihnen ausgewählten Werkzeuggruppen nutzen: Websuche,
                            Abruf von Webseiten, Bilderzeugung, Ausführung von Programmcode, Suche in Ihrer Wissensdatenbank, Datum und Uhrzeit sowie Ihre
                            verbundenen Konnektoren und MCP-Server. Welche Werkzeuge zur Verfügung stehen, ergibt sich allein aus Ihren Einstellungen, nicht aus
                            dem Inhalt der eingehenden Nachricht.
                        </p>
                        <p className="mt-2 text-sm">
                            Wird ein Werkzeug aufgerufen, gelangen Inhalte aus den Messenger-Nachrichten – etwa eine daraus abgeleitete Suchanfrage, eine
                            Adresse oder eine Bildbeschreibung – an den jeweiligen Werkzeug- oder Modellanbieter (siehe Abschnitt 11) bzw. an den Dienst hinter
                            einem von Ihnen verbundenen Konnektor. Antworten mit Werkzeugen werden mit dem Modell Gemini 2.5 Flash (Google) erzeugt. Die
                            Werkzeuge laufen unter Ihrem Konto, mit Ihrem Kontingent und Ihren hinterlegten Schlüsseln; erzeugte Bilder und Dateien werden an
                            den Absender zurückgesendet. Geben Sie die Wissensdatenbank oder Konnektoren frei, können Inhalte daraus in Antworten an die
                            Absender der Nachrichten gelangen – prüfen Sie daher, wem Sie den Bot zugänglich machen.
                        </p>
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Betroffene Personen:</strong> Sie als Inhaber der Anbindung sowie die Absender der Messenger-Nachrichten
                            </li>
                            <li>
                                <strong>Rechtsgrundlage:</strong> Vertragserfüllung (Art. 6 Abs. 1 S. 1 lit. b) DSGVO) Ihnen gegenüber; hinsichtlich der Daten
                                der Absender berechtigte Interessen (Art. 6 Abs. 1 S. 1 lit. f) DSGVO) an der Beantwortung der an den Bot gerichteten
                                Nachrichten
                            </li>
                        </ul>
                        {/*
                         * TODO(owner): the sender-side legal basis (lit. f) above is an assumption — the page
                         * never stated one for messenger senders before. Confirm it, and whether the owner of
                         * a connection is a separate controller towards their senders.
                         */}

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Sprachmodus und Sprachausgabe</h3>
                        <p className="text-sm">
                            Im freihändigen Sprachmodus werden Antworten vorgelesen. Bei angemeldeten Nutzern mit Konto übermitteln wir dazu den Text der
                            Antwort – abschnittsweise, jeweils höchstens 1.000 Zeichen – sowie die gewählte Stimme über unser LLM-Gateway an FAL.ai, wo das
                            Sprachmodell MiniMax Speech die Audiodaten erzeugt. Das Audio wird ausschließlich zur Wiedergabe an Ihren Browser zurückgegeben und
                            weder in der Unterhaltung noch als Datei gespeichert. Gespeichert werden lediglich Nutzungsangaben ohne den Text (Anzahl der
                            Zeichen, Modell, Kosten), um die Kosten mit Ihrem Guthaben zu verrechnen, sowie die Zeichenzahl für das tägliche Kontingent.
                            Hinterlegen Sie einen eigenen FAL-Schlüssel, erfolgt die Übermittlung unter Ihrem eigenen Vertragsverhältnis mit fal.ai.
                        </p>
                        <p className="mt-2 text-sm">
                            Bei Gastkonten, nach Ausschöpfen des täglichen Kontingents, bei einem Fehler sowie für die Funktionen „Vorlesen“ und „Antworten
                            automatisch vorlesen“ nutzen wir stattdessen die Sprachausgabe Ihres Browsers. Wie Ihr Browser oder Betriebssystem diese erzeugt
                            (auf dem Gerät oder über einen Dienst des Herstellers), liegt außerhalb unseres Einflusses.
                        </p>
                        <p className="mt-2 text-sm">
                            Für die Spracheingabe in diesem Modus und beim Diktieren im Eingabefeld überträgt Ihr Browser bei angemeldeten Nutzern das
                            Mikrofonsignal direkt an den Transkriptionsdienst ElevenLabs (Scribe); ElevenLabs erhält dabei auch Ihre IP-Adresse. Ist dieser
                            Dienst nicht verfügbar, verwendet der Browser seine eigene Spracherkennung.
                        </p>
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Verarbeitete Datenarten:</strong> Inhaltsdaten (Antworttext, Spracheingabe), Nutzungsdaten, Meta-/Kommunikationsdaten
                            </li>
                            <li>
                                <strong>Rechtsgrundlage:</strong> Vertragserfüllung (Art. 6 Abs. 1 S. 1 lit. b) DSGVO)
                            </li>
                        </ul>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Ausführung auf Ihren eigenen Geräten (Desktop-App)</h3>
                        <p className="text-sm">
                            Mit der Neore-Desktop-App können Sie Ihren Computer als Gerät mit Ihrem Konto koppeln. Erst nach dieser Kopplung, die Sie auf dem
                            Computer selbst bestätigen, darf der KI-Assistent dort Dateien in von Ihnen freigegebenen Ordnern auflisten, lesen und schreiben,
                            Befehle in einer Kommandozeile ausführen (unter macOS und Linux in einer Sandbox des Betriebssystems) und von Ihnen lokal
                            eingerichtete MCP-Server nutzen. Jede einzelne Aktion wird auf dem Computer angezeigt und läuft erst, wenn Sie sie dort erlauben
                            oder für das betreffende Werkzeug eine Dauerfreigabe erteilt haben. Freigegebene Ordner, lokale MCP-Server und Dauerfreigaben werden
                            nur auf Ihrem Computer gespeichert. Diese Werkzeuge stehen nur in Ihren eigenen, nicht geteilten Unterhaltungen zur Verfügung.
                        </p>
                        <p className="mt-2 text-sm">Dabei verarbeiten wir auf unseren Servern:</p>
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Gerätedaten:</strong> Name und Betriebssystem des Geräts, Zeitpunkt der Kopplung und der letzten Aktivität, die Liste
                                der angebotenen Werkzeuge sowie einen verschlüsselt gespeicherten Schlüssel, mit dem Anfragen und Ergebnisse signiert werden.
                            </li>
                            <li>
                                <strong>Aktivitätsprotokoll:</strong> für jede Aktion das Werkzeug, die Eingabe (z.B. Dateipfad oder Befehl), Ihre Entscheidung,
                                den Status und das Ergebnis bzw. die Ausgabe (höchstens 64 KB), jeweils mit Bezug zur Unterhaltung. Es dient der Anzeige unter
                                „Geräteaktivität“.
                            </li>
                            <li>
                                <strong>Inhalte in der Unterhaltung:</strong> Das Ergebnis einer Aktion – etwa der Inhalt einer gelesenen Datei oder die Ausgabe
                                eines Befehls – wird Teil der Unterhaltung, mit ihr gespeichert und wie andere Chat-Inhalte an den gewählten KI-Modellanbieter
                                übermittelt.
                            </li>
                        </ul>
                        <p className="mt-2 text-sm">
                            Entfernen Sie ein Gerät, werden seine Gerätedaten gelöscht; das Aktivitätsprotokoll bleibt bis zum Ablauf seiner Speicherdauer
                            (Abschnitt 15) erhalten. Geräte und Aktivitätsprotokoll sind in Datenexport und Kontolöschung enthalten.
                        </p>
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Verarbeitete Datenarten:</strong> Inhaltsdaten, Nutzungsdaten, Meta-/Kommunikationsdaten (Geräteinformationen)
                            </li>
                            <li>
                                <strong>Rechtsgrundlage:</strong> Vertragserfüllung (Art. 6 Abs. 1 S. 1 lit. b) DSGVO)
                            </li>
                        </ul>
                    </section>

                    {/* 11. Auftragsverarbeiter */}
                    <section id="auftragsverarbeiter">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">11. Auftragsverarbeiter</h2>
                        <p>
                            Wir setzen folgende Auftragsverarbeiter ein, mit denen wir Verträge zur Auftragsverarbeitung gemäß Art. 28 DSGVO geschlossen haben:
                        </p>

                        <div className="mt-4 space-y-4">
                            <div className="border-brand-silver rounded-md border p-4">
                                <h3 className="text-brand-obsidian mb-1 font-medium">Cloudflare, Inc.</h3>
                                <p className="text-sm">101 Townsend St, San Francisco, CA 94107, USA</p>
                                <p className="mt-1 text-sm">
                                    <strong>Zweck:</strong> Content Delivery Network (CDN), DDoS-Schutz, DNS und Webhosting (Workers) sowie der Betrieb unseres
                                    Backends: Datenbank (D1), Objektspeicher für hochgeladene Dateien (R2), Durable Objects, Vektorindex für die
                                    Wissensdatenbank (Vectorize), Warteschlangen, E-Mail-Zustellung und Browser-Rendering. Konto-, Chat- und Dokumentdaten
                                    werden damit bei Cloudflare gespeichert.
                                </p>
                            </div>
                            {/*
                             * TODO(legal): the entries below are derived from what the code actually
                             * calls, not from signed paperwork. Before publishing, confirm for EACH
                             * one: the correct legal entity and address, that an Art. 28 DSGVO
                             * contract is in place, and whether it is EU-U.S. DPF certified or relies
                             * on SCCs — then align section 12 with the answer.
                             */}
                            <div className="border-brand-silver rounded-md border p-4">
                                <h3 className="text-brand-obsidian mb-1 font-medium">KI-Modellanbieter</h3>
                                <p className="text-sm">OpenRouter, Groq, xAI, Google, OpenAI, Requesty, FAL.ai, Black Forest Labs, Replicate</p>
                                <p className="mt-1 text-sm">
                                    <strong>Zweck:</strong> Erzeugung von Antworten, Bildern, Video und Audio. Diesen Anbietern werden die Inhalte Ihrer
                                    Eingaben (Prompts), beigefügte Dateien sowie der für die Antwort benötigte Gesprächsverlauf übermittelt. Welcher Anbieter
                                    eine einzelne Anfrage verarbeitet, hängt vom gewählten Modell ab. Hinterlegen Sie einen eigenen API-Schlüssel („Bring Your
                                    Own Key“), erfolgt die Übermittlung an den betreffenden Anbieter auf Grundlage Ihres eigenen Vertragsverhältnisses mit
                                    diesem.
                                </p>
                                <p className="mt-1 text-sm">
                                    FAL.ai erzeugt zudem die Sprachausgabe im Sprachmodus (Modell MiniMax Speech); dafür erhält FAL.ai den vorzulesenden
                                    Antworttext und die gewählte Stimme.
                                </p>
                            </div>
                            {/*
                             * TODO(owner): ElevenLabs is a recipient the page never named before (browser →
                             * ElevenLabs Scribe for dictation and hands-free listening, see
                             * apps/web/src/features/chat/thread/dictation/elevenlabs-scribe.ts). Confirm the
                             * legal entity, the Art. 28 contract and the transfer basis (DPF vs. SCCs), and
                             * align the section 12 entry with it.
                             */}
                            <div className="border-brand-silver rounded-md border p-4">
                                <h3 className="text-brand-obsidian mb-1 font-medium">ElevenLabs</h3>
                                <p className="mt-1 text-sm">
                                    <strong>Zweck:</strong> Spracherkennung (Transkription) beim Diktieren und im Sprachmodus. Ihr Browser überträgt das
                                    Mikrofonsignal mit einem kurzlebigen, einmal verwendbaren Zugangstoken direkt an ElevenLabs.
                                </p>
                            </div>
                            <div className="border-brand-silver rounded-md border p-4">
                                <h3 className="text-brand-obsidian mb-1 font-medium">Resend (Plus Five Five, Inc.)</h3>
                                <p className="text-sm">2261 Market Street, San Francisco, CA 94114, USA</p>
                                <p className="mt-1 text-sm">
                                    <strong>Zweck:</strong> Versand transaktionaler E-Mails (Registrierungsbestätigung, Einladungen, Passwortzurücksetzung),
                                    soweit der Versand nicht über Cloudflare erfolgt.
                                </p>
                            </div>
                            <div className="border-brand-silver rounded-md border p-4">
                                <h3 className="text-brand-obsidian mb-1 font-medium">Werkzeug- und Datenanbieter</h3>
                                <p className="text-sm">
                                    Exa, Tavily, Firecrawl, Parallel, Valyu (Websuche und Recherche), E2B (Ausführung von Programmcode), GitHub, Google Maps,
                                    OpenWeather, Spotify, TMDB, CoinGecko, Amadeus, Supadata, Wolfram Alpha
                                </p>
                                <p className="mt-1 text-sm">
                                    <strong>Zweck:</strong> Ausführung der von Ihnen im Chat angeforderten Werkzeuge sowie der Werkzeuge, die Sie für
                                    Messenger-Antworten freigegeben haben. Eine Übermittlung findet nur statt, wenn das jeweilige Werkzeug im Verlauf einer
                                    Unterhaltung tatsächlich aufgerufen wird, und beschränkt sich auf die dafür erforderliche Eingabe (etwa eine Suchanfrage,
                                    eine URL oder ein Codeausschnitt).
                                </p>
                            </div>
                            <div className="border-brand-silver rounded-md border p-4">
                                <h3 className="text-brand-obsidian mb-1 font-medium">PostHog, Inc.</h3>
                                <p className="text-sm">2261 Market Street #4008, San Francisco, CA 94114, USA</p>
                                <p className="mt-1 text-sm">
                                    <strong>Zweck:</strong> Webanalyse, Produktanalyse, Feature-Flags
                                </p>
                            </div>
                        </div>
                    </section>

                    {/* 12. Internationale Datentransfers */}
                    <section id="drittland">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">12. Internationale Datentransfers</h2>
                        <p>
                            Im Rahmen unserer Datenverarbeitung werden personenbezogene Daten an Drittländer außerhalb der Europäischen Union bzw. des
                            Europäischen Wirtschaftsraums übermittelt, insbesondere in die USA.
                        </p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Rechtsgrundlage der Übermittlung</h3>
                        <p className="text-sm">
                            Die Datenübermittlung in die USA erfolgt auf Grundlage des Angemessenheitsbeschlusses der Europäischen Kommission gemäß Art. 45
                            DSGVO zum EU-U.S. Data Privacy Framework (DPF). Sofern Empfänger nicht unter dem DPF zertifiziert sind, stützen wir die Übermittlung
                            auf Standardvertragsklauseln der EU-Kommission gemäß Art. 46 Abs. 2 lit. c) DSGVO, ergänzt durch geeignete technische und
                            organisatorische Maßnahmen.
                        </p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Betroffene Dienste</h3>
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Cloudflare, Inc.</strong> – unter dem EU-U.S. DPF zertifiziert
                            </li>
                            <li>
                                <strong>KI-Modellanbieter</strong> (OpenRouter, Groq, xAI, Google, OpenAI, Requesty, FAL.ai, Black Forest Labs, Replicate) –
                                Standardvertragsklauseln (SCCs), soweit nicht unter dem EU-U.S. DPF zertifiziert
                            </li>
                            <li>
                                <strong>Resend (Plus Five Five, Inc.)</strong> – Standardvertragsklauseln (SCCs)
                            </li>
                            <li>
                                <strong>ElevenLabs</strong> – Standardvertragsklauseln (SCCs), soweit nicht unter dem EU-U.S. DPF zertifiziert
                            </li>
                            <li>
                                <strong>Werkzeug- und Datenanbieter</strong> – Standardvertragsklauseln (SCCs), soweit eine Übermittlung durch Aufruf des
                                jeweiligen Werkzeugs ausgelöst wird
                            </li>
                            <li>
                                <strong>PostHog, Inc.</strong> – Standardvertragsklauseln (SCCs)
                            </li>
                        </ul>

                        <p className="mt-4 text-sm">
                            Sie können eine Kopie der Standardvertragsklauseln bei uns anfordern. Kontaktdaten finden Sie unter Abschnitt 1 dieser
                            Datenschutzerklärung.
                        </p>
                    </section>

                    {/* 13. Cookies */}
                    <section id="cookies">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">13. Cookies und Speichertechnologien</h2>
                        <p>
                            Wir setzen Cookies und vergleichbare Speichertechnologien (z.B. Local Storage) ein, um unser Onlineangebot sicher und
                            nutzerfreundlich bereitzustellen. Gemäß § 25 Abs. 1 TDDDG ist das Speichern von und der Zugriff auf Informationen in der
                            Endeinrichtung des Endnutzers nur mit dessen Einwilligung zulässig, es sei denn, dies ist technisch unbedingt erforderlich (§ 25
                            Abs. 2 TDDDG).
                        </p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Notwendige Cookies</h3>
                        <p className="text-sm">
                            Bestimmte Cookies sind technisch erforderlich, damit die Webseite funktioniert (z.B. Session-Cookies für die Authentifizierung).
                            Diese sind gemäß § 25 Abs. 2 TDDDG von der Einwilligungspflicht ausgenommen. Die Verarbeitung der damit verbundenen
                            personenbezogenen Daten erfolgt auf Grundlage unserer berechtigten Interessen gemäß Art. 6 Abs. 1 S. 1 lit. f) DSGVO.
                        </p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Analyse-Cookies</h3>
                        <p className="text-sm">
                            Cookies für Analysezwecke (z.B. PostHog) werden nur mit Ihrer Einwilligung gemäß § 25 Abs. 1 TDDDG i.V.m. Art. 6 Abs. 1 S. 1 lit. a)
                            DSGVO gesetzt. Sie können Ihre Einwilligung jederzeit über die Cookie-Einstellungen widerrufen.
                        </p>
                    </section>

                    {/* 14. Rechte der Betroffenen */}
                    <section id="rechte">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">14. Rechte der betroffenen Personen</h2>
                        <p>Ihnen stehen als Betroffene nach der DSGVO verschiedene Rechte zu, die sich insbesondere aus Art. 15 bis 21 DSGVO ergeben:</p>
                        <ul className="mt-4 list-inside list-disc space-y-2 text-sm">
                            <li>
                                <strong>Widerspruchsrecht (Art. 21 DSGVO):</strong> Sie haben das Recht, aus Gründen, die sich aus Ihrer besonderen Situation
                                ergeben, jederzeit gegen die Verarbeitung Sie betreffender personenbezogener Daten, die auf Grundlage von Art. 6 Abs. 1 S. 1
                                lit. f) DSGVO erfolgt, Widerspruch einzulegen.
                            </li>
                            <li>
                                <strong>Widerrufsrecht bei Einwilligungen:</strong> Sie haben das Recht, erteilte Einwilligungen jederzeit zu widerrufen.
                            </li>
                            <li>
                                <strong>Auskunftsrecht (Art. 15 DSGVO):</strong> Sie haben das Recht, eine Bestätigung darüber zu verlangen, ob betreffende
                                Daten verarbeitet werden, und auf Auskunft über diese Daten.
                            </li>
                            <li>
                                <strong>Berichtigungsrecht (Art. 16 DSGVO):</strong> Sie haben das Recht, die Berichtigung unrichtiger oder die
                                Vervollständigung Sie betreffender Daten zu verlangen.
                            </li>
                            <li>
                                <strong>Löschungsrecht (Art. 17 DSGVO):</strong> Sie haben das Recht, zu verlangen, dass betreffende Daten unverzüglich gelöscht
                                werden.
                            </li>
                            <li>
                                <strong>Recht auf Einschränkung der Verarbeitung (Art. 18 DSGVO):</strong> Sie haben das Recht, die Einschränkung der
                                Verarbeitung zu verlangen.
                            </li>
                            <li>
                                <strong>Recht auf Datenübertragbarkeit (Art. 20 DSGVO):</strong> Sie haben das Recht, die Sie betreffenden Daten in einem
                                strukturierten, gängigen und maschinenlesbaren Format zu erhalten.
                            </li>
                            <li>
                                <strong>Beschwerderecht bei einer Aufsichtsbehörde:</strong> Sie haben das Recht, sich bei einer Aufsichtsbehörde zu beschweren,
                                wenn Sie der Ansicht sind, dass die Verarbeitung der Sie betreffenden personenbezogenen Daten gegen die DSGVO verstößt.
                            </li>
                        </ul>
                    </section>

                    {/* 15. Löschung */}
                    <section id="loeschung">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">15. Löschung von Daten</h2>
                        <p>
                            Die von uns verarbeiteten Daten werden nach Maßgabe der gesetzlichen Vorgaben gelöscht, sobald deren zur Verarbeitung erlaubte
                            Einwilligungen widerrufen werden oder sonstige Erlaubnisse entfallen (z.B. wenn der Zweck der Verarbeitung dieser Daten entfallen
                            ist oder sie für den Zweck nicht erforderlich sind).
                        </p>
                        <p className="mt-2">
                            Sofern die Daten nicht gelöscht werden, weil sie für andere und gesetzlich zulässige Zwecke erforderlich sind, wird deren
                            Verarbeitung auf diese Zwecke beschränkt. D.h., die Daten werden gesperrt und nicht für andere Zwecke verarbeitet. Das gilt z.B. für
                            Daten, die aus handels- oder steuerrechtlichen Gründen aufbewahrt werden müssen.
                        </p>
                        <p className="mt-2">Nutzer können ihr Konto und die damit verbundenen Daten jederzeit in den Kontoeinstellungen löschen.</p>

                        <h3 className="text-brand-obsidian mt-6 mb-2 text-lg font-medium">Konkrete Speicherdauern</h3>
                        <p className="text-sm">Soweit keine längere gesetzliche Aufbewahrungspflicht besteht, gelten die folgenden Fristen:</p>
                        <ul className="mt-2 list-inside list-disc space-y-1 text-sm">
                            <li>
                                <strong>Konto-, Chat- und Dokumentdaten:</strong> bis zur Löschung durch Sie. Mit der Kontolöschung werden auch Unterhaltungen,
                                Dateien, Gedächtniseinträge und Vektorindizes entfernt.
                            </li>
                            <li>
                                <strong>Verlaufsdaten der KI-Verarbeitung:</strong> 90 Tage.
                            </li>
                            <li>
                                <strong>Nutzungsstatistik</strong> (je Tag und Skill: Anzahl der Antworten, verbrauchte Token und Kosten, Grundlage der
                                Nutzungsübersicht): 400 Tage. Die Kennungen, mit denen einzelne Antworten nur einmal gezählt werden, werden nach zwei Tagen
                                gelöscht, sobald die einmalige Nacherfassung älterer Antworten für Ihr Konto abgeschlossen ist.
                            </li>
                            <li>
                                <strong>Aktivitätsprotokoll gekoppelter Geräte:</strong> 30 Tage ab der jeweiligen Aktion; die Bereinigung läuft regelmäßig, bei
                                länger inaktiven Konten spätestens bei der nächsten Nutzung.
                            </li>
                            <li>
                                <strong>Audiodaten der Sprachausgabe:</strong> keine Speicherung.
                            </li>
                            <li>
                                <strong>Temporäre Unterhaltungen:</strong> bis zum Ablauf der von Ihnen gewählten Frist; die Löschung läuft stündlich.
                            </li>
                            <li>
                                <strong>Hochgeladene Dateien ohne Bezug zu einer Unterhaltung:</strong> stündliche Löschung.
                            </li>
                            <li>
                                <strong>Bereitgestellte Datenexporte:</strong> Löschung nach Ablauf des Download-Zeitraums, Prüfung alle sechs Stunden.
                            </li>
                            <li>
                                <strong>Anträge nach Art. 15 ff. DSGVO:</strong> Bearbeitung innerhalb der Frist des Art. 12 Abs. 3 DSGVO; offene Anträge laufen
                                nach 30 Tagen ab.
                            </li>
                        </ul>
                    </section>

                    {/* 16. Änderungen */}
                    <section id="aenderungen">
                        <h2 className="text-brand-obsidian mb-4 text-xl font-semibold">16. Änderung dieser Datenschutzerklärung</h2>
                        <p>
                            Wir behalten uns vor, diese Datenschutzerklärung anzupassen, damit sie stets den aktuellen rechtlichen Anforderungen entspricht oder
                            um Änderungen unserer Leistungen in der Datenschutzerklärung umzusetzen, z.B. bei der Einführung neuer Services. Für Ihren erneuten
                            Besuch gilt dann die neue Datenschutzerklärung.
                        </p>
                    </section>

                    {/* Navigation */}
                    <div className="border-brand-silver border-t pt-8">
                        <Link className="text-primary text-sm font-medium underline underline-offset-2 hover:opacity-80" to="/impressum">
                            Impressum ansehen →
                        </Link>
                    </div>
                </div>
            </div>
        </main>

        <LandingFooter />
    </div>
);

export default DatenschutzPage;
