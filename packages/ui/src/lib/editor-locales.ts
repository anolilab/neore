/**
 * Custom locale messages for reactjs-tiptap-editor.
 *
 * The editor ships with: en, vi, zh_CN, pt_BR, hu_HU, fi.
 * Any language not in that list must be registered via localeActions.setMessage().
 *
 * Add new locales here as the app's supported languages grow.
 * Keys are sourced from the English locale (the source of truth for all available keys).
 */

import { localeActions } from "reactjs-tiptap-editor/locale-bundle";

export const de = {
    Activity: "Aktivität",
    "Animals & Nature": "Tiere & Natur",
    "editor.attachment.please_upload": "Bitte Datei hochladen",
    "editor.attachment.tooltip": "Anhang",
    "editor.attachment.uploading": "Wird hochgeladen",
    // Blocks
    "editor.blockquote.tooltip": "Blockzitat",
    // Text marks
    "editor.bold.tooltip": "Fett",
    // Lists
    "editor.bulletlist.tooltip": "Aufzählungsliste",
    "editor.callout.dialog.body.label": "Inhalt",
    "editor.callout.dialog.body.placeholder": "Inhalt eingeben (optional)",
    "editor.callout.dialog.button.apply": "Einfügen",
    "editor.callout.dialog.button.cancel": "Abbrechen",
    "editor.callout.dialog.title": "Hinweisbox einfügen",
    "editor.callout.dialog.title.label": "Titel",
    "editor.callout.dialog.title.placeholder": "Benutzerdefinierten Titel eingeben (optional)",
    "editor.callout.dialog.type": "Typ der Hinweisbox",
    "editor.callout.dialog.type.placeholder": "Typ auswählen",
    "editor.callout.edit.title": "Hinweisbox bearbeiten",
    // Callout
    "editor.callout.tooltip": "Hinweisbox",
    "editor.callout.type.caution": "Achtung",

    "editor.callout.type.important": "Wichtig",
    "editor.callout.type.note": "Hinweis",
    "editor.callout.type.tip": "Tipp",
    "editor.callout.type.warning": "Warnung",
    "editor.characters": "ZEICHEN",
    // Actions
    "editor.clear.tooltip": "Formatierung löschen",
    "editor.code.tooltip": "Code",
    "editor.codeblock.tooltip": "Codeblock",

    "editor.codeView.tooltip": "Code-Ansicht",
    "editor.color.more": "Weitere Farben",
    "editor.color.tooltip": "Farbe",
    "editor.columns.tooltip": "Spalten",
    "editor.content": "Bitte Inhalt eingeben",
    "editor.copy": "Kopieren",
    "editor.copyToClipboard": "In Zwischenablage kopieren",
    "editor.default": "Standard",
    "editor.delete": "Löschen",
    "editor.draghandle.tooltip": "Ändern",

    "editor.edit": "Bearbeiten",
    "editor.emoji.tooltip": "Emoji",
    "editor.exportPdf.tooltip": "Als PDF exportieren",
    "editor.exportWord.tooltip": "Als Word exportieren",
    "editor.fontFamily.default.tooltip": "Standard",
    // Font
    "editor.fontFamily.tooltip": "Schriftfamilie",
    "editor.fontSize.default.tooltip": "Standard",
    "editor.fontSize.tooltip": "Schriftgröße",

    "editor.format": "Format übertragen",
    "editor.formula.dialog.text": "Formel",
    "editor.fullscreen.tooltip.exit": "Vollbild beenden",
    "editor.fullscreen.tooltip.fullscreen": "Vollbild",
    "editor.heading.h1.tooltip": "Überschrift 1",

    "editor.heading.h2.tooltip": "Überschrift 2",
    "editor.heading.h3.tooltip": "Überschrift 3",
    "editor.heading.h4.tooltip": "Überschrift 4",
    "editor.heading.h5.tooltip": "Überschrift 5",
    "editor.heading.h6.tooltip": "Überschrift 6",

    // Headings & paragraph
    "editor.heading.tooltip": "Überschriften",
    "editor.highlight.tooltip": "Hervorheben",
    "editor.horizontalrule.tooltip": "Horizontale Linie",
    // Misc extensions
    "editor.iframe.tooltip": "iFrame",

    "editor.image.dialog.button.apply": "Übernehmen",
    "editor.image.dialog.form.alt": "Alt-Text",
    "editor.image.dialog.form.aspectRatio": "Originales Seitenverhältnis beibehalten",
    "editor.image.dialog.form.file": "Datei",
    "editor.image.dialog.form.link": "Link",
    "editor.image.dialog.placeholder": "Link",
    "editor.image.dialog.tab.upload": "Hochladen",
    "editor.image.dialog.tab.uploadCrop": "Hochladen & Zuschneiden",
    "editor.image.dialog.tab.url": "URL",
    "editor.image.dialog.title": "Bild hinzufügen",
    "editor.image.dialog.uploading": "Wird hochgeladen",
    "editor.image.dragger.tooltip": "Bild anklicken oder in den Bereich ziehen, um es hochzuladen",
    "editor.image.float.left.tooltip": "Links umfließen",

    "editor.image.float.none.tooltip": "Kein Umfluss",
    "editor.image.float.right.tooltip": "Rechts umfließen",
    // Image
    "editor.image.tooltip": "Bild",
    "editor.imageGif.tooltip": "GIF",
    "editor.imageUpload.alt": "Alt-Text",
    "editor.imageUpload.cancel": "Abbrechen",
    "editor.imageUpload.crop": "Zuschneiden",
    "editor.imageUpload.fileSizeTooBig": "Datei zu groß, maximale Größe ist",
    "editor.imageUpload.fileTypeNotSupported": "Dateityp nicht unterstützt",
    "editor.imageUpload.uploading": "Wird hochgeladen…",
    "editor.importWord.convertError": "Fehler beim Analysieren des Word-Dokuments",
    "editor.importWord.converting": "Word-Dokument wird konvertiert, bitte warten…",
    "editor.importWord.importError": "Fehler beim Importieren des Word-Dokuments",
    "editor.importWord.limitSize": "Dateigröße darf nicht überschreiten",
    "editor.importWord.tooltip": "Word importieren",
    // Indent
    "editor.indent": "Einzug",
    "editor.indent.indent": "Einzug vergrößern",
    "editor.indent.outdent": "Einzug verkleinern",
    "editor.indent.tooltip": "Einzug",
    "editor.italic.tooltip": "Kursiv",
    "editor.katex.tooltip": "Mathematische Formel",
    "editor.lineheight.tooltip": "Zeilenhöhe",
    "editor.link.dialog.button.apply": "Übernehmen",

    "editor.link.dialog.button.cancel": "Abbrechen",
    "editor.link.dialog.inline": "Inline",
    "editor.link.dialog.link": "Link",
    "editor.link.dialog.link.placeholder": "Linkadresse",
    "editor.link.dialog.openInNewTab": "In neuem Tab öffnen",
    "editor.link.dialog.text": "Text",
    "editor.link.dialog.text.placeholder": "Beschreibung hinzufügen",

    "editor.link.dialog.title": "Link einfügen",
    "editor.link.edit.tooltip": "Link bearbeiten",
    "editor.link.open.tooltip": "Link öffnen",
    // Link
    "editor.link.tooltip": "Link",
    "editor.link.unlink.tooltip": "Link entfernen",
    "editor.mermaid.tooltip": "Mermaid-Diagramm",
    "editor.moremark": "Weitere Textstile",
    "editor.next.dialog.text": "Weiter",
    "editor.nofill": "Keine Füllung",
    "editor.orderedlist.tooltip": "Nummerierte Liste",
    "editor.outdent.tooltip": "Ausrücken",
    "editor.paragraph.tooltip": "Absatz",
    "editor.previous.dialog.text": "Zurück",
    "editor.recent": "Zuletzt verwendet",
    "editor.redo.tooltip": "Wiederholen",
    // General
    "editor.remove": "Entfernen",
    "editor.replace.caseSensitive": "Groß-/Kleinschreibung beachten",
    "editor.replace.dialog.text": "Ersetzen",
    "editor.replaceAll.dialog.text": "Alle ersetzen",
    "editor.search.dialog.text": "Suchen",
    // Search & Replace
    "editor.searchAndReplace.tooltip": "Suchen und Ersetzen",

    "editor.settings": "Einstellungen",
    "editor.size.large.tooltip": "Groß",
    "editor.size.medium.tooltip": "Mittel",
    "editor.size.small.tooltip": "Klein",

    "editor.slash": '„/" für Befehle drücken',
    "editor.slash.embed": "Eingebettete Dienste",
    "editor.slash.empty": "Kein Ergebnis",
    "editor.slash.format": "Formatierung",
    "editor.slash.insert": "Einfügen",

    "editor.strike.tooltip": "Durchstreichen",
    "editor.subscript.tooltip": "Tiefgestellt",
    "editor.superscript.tooltip": "Hochgestellt",
    "editor.table.menu.add_column_after": "Spalte danach einfügen",
    "editor.table.menu.add_column_before": "Spalte davor einfügen",
    "editor.table.menu.add_row_after": "Zeile darunter einfügen",

    "editor.table.menu.add_row_before": "Zeile darüber einfügen",
    "editor.table.menu.delete_column": "Spalte löschen",
    "editor.table.menu.delete_row": "Zeile löschen",
    "editor.table.menu.delete_table": "Tabelle löschen",
    "editor.table.menu.deleteColumn": "Spalte löschen",
    "editor.table.menu.deleteRow": "Zeile löschen",
    "editor.table.menu.deleteTable": "Tabelle löschen",
    "editor.table.menu.insert_table": "Tabelle einfügen",

    "editor.table.menu.insert_table.with_header_row": "Mit Kopfzeile",
    "editor.table.menu.insertColumnAfter": "Spalte danach einfügen",
    "editor.table.menu.insertColumnBefore": "Spalte davor einfügen",
    "editor.table.menu.insertRowAbove": "Zeile darüber einfügen",
    "editor.table.menu.insertRowBelow": "Zeile darunter einfügen",
    "editor.table.menu.merge_or_split_cells": "Zellen verbinden oder teilen",
    "editor.table.menu.mergeCells": "Zellen verbinden",
    "editor.table.menu.setCellsBgColor": "Zellenhintergrundfarbe",
    "editor.table.menu.splitCells": "Zellen teilen",
    // Table
    "editor.table.tooltip": "Tabelle",

    "editor.table_of_content": "Inhaltsverzeichnis",
    "editor.tasklist.tooltip": "Aufgabenliste",
    "editor.textalign.center.tooltip": "Zentriert",
    "editor.textalign.justify.tooltip": "Blocksatz",
    "editor.textalign.left.tooltip": "Links",
    "editor.textalign.right.tooltip": "Rechts",
    // Alignment
    "editor.textalign.tooltip": "Ausrichten",
    "editor.textDirection.auto.tooltip": "Automatisch",
    "editor.textDirection.ltr.tooltip": "Links nach rechts",
    "editor.textDirection.rtl.tooltip": "Rechts nach links",
    // Text direction
    "editor.textDirection.tooltip": "Textrichtung",
    "editor.textDirection.unset.tooltip": "Zurücksetzen",
    // Image tools
    "editor.tooltip.flipX": "Horizontal spiegeln",

    "editor.tooltip.flipY": "Vertikal spiegeln",
    "editor.twitter.tooltip": "Twitter",
    "editor.underline.tooltip": "Unterstreichen",
    "editor.undo.tooltip": "Rückgängig",
    "editor.upload.error": "Fehler beim Hochladen der Datei",

    "editor.upload.fileSizeTooBig": "{fileName} zu groß, maximale Größe ist {size} MB",
    // Upload (generic)
    "editor.upload.fileTypeNotSupported": "{fileName} – Dateityp nicht unterstützt",

    "editor.video.dialog.button.apply": "Übernehmen",
    "editor.video.dialog.link": "Link",
    "editor.video.dialog.placeholder": "Link",
    "editor.video.dialog.tab.upload": "Hochladen",
    "editor.video.dialog.title": "Video einbetten oder hochladen",
    "editor.video.dialog.uploading": "Wird hochgeladen",
    // Video
    "editor.video.tooltip": "Video",
    "editor.words": "WÖRTER",
    Flags: "Flaggen",
    "Food & Drink": "Essen & Trinken",
    "Frequently used": "Häufig verwendet",
    no_result_found: "Kein Ergebnis gefunden",
    Object: "Objekte",
    // Emoji categories
    "Smileys & People": "Smileys & Personen",
    Symbol: "Symbole",
    "Travel & Places": "Reisen & Orte",
} as const;

// Auto-register all custom locales when this module is imported.
localeActions.setMessage("de", de);

/**
 * Maps app locale codes (BCP 47) to reactjs-tiptap-editor locale codes.
 * Falls back to "en" for unsupported locales.
 * Extend this map when adding new languages to the app.
 */
export const EDITOR_LOCALE_MAP: Record<string, string> = {
    de: "de",
    en: "en",
};
