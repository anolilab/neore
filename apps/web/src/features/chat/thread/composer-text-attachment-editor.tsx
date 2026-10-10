"use client";

/**
 * Text Attachment Editor Dialog
 *
 * Full-screen dialog for previewing and editing text-based attachments
 */

import { Plural, Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@neore/ui/components/button";
import { Dialog, DialogBackdrop, DialogClose, DialogDescription, DialogPopup } from "@neore/ui/components/dialog";
import { InlineEdit } from "@neore/ui/components/inline-edit";
import { formatNumber } from "@neore/ui/utils/locale-format";
import clsx from "clsx";
import { AlertTriangleIcon, CheckIcon, EditIcon, EyeIcon, FileTextIcon, InfoIcon, XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { FC } from "react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

const WHITESPACE_RE = /\s+/;

// Lazy load CodeMirror editor
const CanvasCodemirrorEditor = lazy(() => import("@/features/canvas/editors/canvas-codemirror-editor"));

// Context window limits (in characters, roughly 4 chars per token)
const CONTEXT_WARNING_THRESHOLD = 100_000; // ~25k tokens - show warning
const CONTEXT_ERROR_THRESHOLD = 400_000; // ~100k tokens - strong warning

interface TextAttachmentEditorDialogProps {
    file: File;
    onOpenChange: (open: boolean) => void;
    onUpdate: (newFile: File) => void;
    open: boolean;
}

// Comprehensive list of allowed text-based file extensions
const ALLOWED_EXTENSIONS = new Set([
    "ada",
    "adb",
    "ads",
    "applescript",
    "as",
    "asc",
    "ascii",
    "ascx",
    "asm",
    "asmx",
    "asp",
    "aspx",
    "atom",
    "au3",
    "awk",
    "bas",
    "bash",
    "bashrc",
    "bat",
    "bbcolors",
    "bcp",
    "bdsgroup",
    "bdsproj",
    "bib",
    "bowerrc",
    "c",
    "cbl",
    "cc",
    "cfc",
    "cfg",
    "cfm",
    "cfml",
    "cgi",
    "cjs",
    "clj",
    "cljs",
    "cls",
    "cmake",
    "cmd",
    "cnf",
    "cob",
    "code-snippets",
    "coffee",
    "coffeekup",
    "conf",
    "cp",
    "cpp",
    "cpt",
    "cpy",
    "crt",
    "cs",
    "csh",
    "cson",
    "csproj",
    "csr",
    "css",
    "csslintrc",
    "csv",
    "ctl",
    "cts",
    "curlrc",
    "cxx",
    "d",
    "dart",
    "dfm",
    "diff",
    "dof",
    "dpk",
    "dpr",
    "dproj",
    "dtd",
    "eco",
    "editorconfig",
    "ejs",
    "el",
    "elm",
    "emacs",
    "eml",
    "ent",
    "erb",
    "erl",
    "eslintignore",
    "eslintrc",
    "ex",
    "exs",
    "f",
    "f03",
    "f77",
    "f90",
    "f95",
    "fish",
    "for",
    "fpp",
    "frm",
    "fs",
    "fsproj",
    "fsx",
    "ftn",
    "gemrc",
    "gemspec",
    "gitattributes",
    "gitconfig",
    "gitignore",
    "gitkeep",
    "gitmodules",
    "go",
    "gpp",
    "gradle",
    "graphql",
    "groovy",
    "groupproj",
    "grunit",
    "gtmpl",
    "gvimrc",
    "h",
    "haml",
    "hbs",
    "hgignore",
    "hh",
    "hpp",
    "hrl",
    "hs",
    "hta",
    "htaccess",
    "htc",
    "htm",
    "html",
    "htpasswd",
    "hxx",
    "iced",
    "iml",
    "inc",
    "inf",
    "info",
    "ini",
    "ino",
    "int",
    "irbrc",
    "itcl",
    "itermcolors",
    "itk",
    "jade",
    "java",
    "jhtm",
    "jhtml",
    "js",
    "jscsrc",
    "jshintignore",
    "jshintrc",
    "json",
    "json5",
    "jsonld",
    "jsp",
    "jspx",
    "jsx",
    "ksh",
    "kt",
    "kts",
    "less",
    "lhs",
    "lisp",
    "log",
    "ls",
    "lsp",
    "lua",
    "m",
    "m4",
    "mak",
    "map",
    "markdown",
    "master",
    "md",
    "mdown",
    "mdwn",
    "mdx",
    "metadata",
    "mht",
    "mhtml",
    "mjs",
    "mk",
    "mkd",
    "mkdn",
    "mkdown",
    "ml",
    "mli",
    "mm",
    "mts",
    "mxml",
    "nfm",
    "nfo",
    "noon",
    "npmignore",
    "npmrc",
    "nuspec",
    "nvmrc",
    "ops",
    "pas",
    "pasm",
    "patch",
    "pbxproj",
    "pch",
    "pem",
    "pg",
    "php",
    "php3",
    "php4",
    "php5",
    "phpt",
    "phtml",
    "pir",
    "pl",
    "pm",
    "pmc",
    "pod",
    "pot",
    "prettierrc",
    "properties",
    "props",
    "proto",
    "pt",
    "pug",
    "purs",
    "py",
    "pyx",
    "r",
    "rake",
    "rb",
    "rbw",
    "rc",
    "rdoc",
    "rdoc_options",
    "resx",
    "rexx",
    "rhtml",
    "rjs",
    "rlib",
    "ron",
    "rs",
    "rss",
    "rst",
    "rtf",
    "rvmrc",
    "rxml",
    "s",
    "sass",
    "scala",
    "scm",
    "scss",
    "seestyle",
    "sh",
    "shtml",
    "sln",
    "sls",
    "spec",
    "sql",
    "sqlite",
    "sqlproj",
    "srt",
    "ss",
    "sss",
    "st",
    "strings",
    "sty",
    "styl",
    "stylus",
    "sub",
    "sublime-build",
    "sublime-commands",
    "sublime-completions",
    "sublime-keymap",
    "sublime-macro",
    "sublime-menu",
    "sublime-project",
    "sublime-settings",
    "sublime-workspace",
    "sv",
    "svc",
    "svg",
    "swift",
    "t",
    "tcl",
    "tcsh",
    "terminal",
    "tex",
    "text",
    "textile",
    "tg",
    "tk",
    "tmLanguage",
    "tmpl",
    "tmTheme",
    "toml",
    "tpl",
    "ts",
    "tsv",
    "tsx",
    "tt",
    "tt2",
    "ttml",
    "twig",
    "txt",
    "v",
    "vb",
    "vbproj",
    "vbs",
    "vcproj",
    "vcxproj",
    "vh",
    "vhd",
    "vhdl",
    "vim",
    "viminfo",
    "vimrc",
    "vm",
    "vue",
    "webapp",
    "webmanifest",
    "wsc",
    "x-php",
    "xaml",
    "xht",
    "xhtml",
    "xml",
    "xs",
    "xsd",
    "xsl",
    "xslt",
    "y",
    "yaml",
    "yml",
    "zig",
    "zsh",
    "zshrc",
]);

// Supported editable file types (MIME types)
const EDITABLE_TYPES = new Set([
    "application/json",
    "application/xml",
    "text/css",
    "text/html",
    "text/javascript",
    "text/markdown",
    "text/plain",
    "text/typescript",
]);

const isEditable = (file: File): boolean => {
    if (EDITABLE_TYPES.has(file.type)) {
        return true;
    }

    // Check by extension
    const extension = file.name.split(".").pop()?.toLowerCase();

    return extension ? ALLOWED_EXTENSIONS.has(extension) : false;
};

// Detect language from file extension for syntax highlighting
const detectLanguage = (filename: string): string => {
    const extension = filename.split(".").pop()?.toLowerCase();
    const langMap: Record<string, string> = {
        ada: "ada",
        awk: "awk",
        bash: "shell",
        bat: "batch",
        // C-family
        c: "c",
        cbl: "cobol",
        cc: "cpp",
        cfg: "ini",

        cjs: "javascript",
        clj: "clojure",
        cljs: "clojure",
        cmake: "cmake",
        cmd: "batch",
        cob: "cobol",
        conf: "ini",
        cpp: "cpp",
        cs: "csharp",
        css: "css",
        csv: "text",
        cts: "typescript",
        cxx: "cpp",

        d: "d",
        dart: "dart",
        diff: "diff",
        dockerfile: "dockerfile",
        ejs: "ejs",
        el: "lisp",
        elm: "elm",
        erb: "erb",

        f: "fortran",
        f90: "fortran",
        f95: "fortran",

        fish: "shell",
        fs: "fsharp",
        fsx: "fsharp",
        gemspec: "ruby",
        // Systems
        go: "go",
        gql: "graphql",
        gradle: "groovy",
        graphql: "graphql",

        groovy: "groovy",
        h: "c",
        haml: "haml",
        hbs: "handlebars",
        hh: "cpp",
        hpp: "cpp",
        hs: "haskell",
        htm: "html",
        // Web
        html: "html",

        hxx: "cpp",
        // Config files
        ini: "ini",
        jade: "pug",
        // Java/JVM
        java: "java",
        // JavaScript/TypeScript
        js: "javascript",

        // Data formats
        json: "json",
        json5: "json",
        jsonld: "json",
        jsx: "jsx",
        ksh: "shell",
        kt: "kotlin",
        kts: "kotlin",
        less: "less",

        lhs: "haskell",
        // Lisp family
        lisp: "lisp",
        log: "log",
        lsp: "lisp",

        lua: "lua",
        mak: "makefile",
        makefile: "makefile",
        markdown: "markdown",
        // Markup & Templates
        md: "markdown",

        mdown: "markdown",
        mdx: "markdown",
        mjs: "javascript",

        mk: "makefile",
        mkd: "markdown",
        // ML family
        ml: "ocaml",
        mli: "ocaml",

        mts: "typescript",
        nginx: "nginx",
        pas: "pascal",
        patch: "diff",
        // PHP
        php: "php",
        php3: "php",
        php4: "php",

        php5: "php",
        phtml: "php",
        // Perl
        pl: "perl",
        pm: "perl",
        pod: "perl",
        proto: "protobuf",
        ps1: "powershell",
        pug: "pug",
        // Python
        py: "python",
        pyw: "python",
        pyx: "python",
        // Other
        r: "r",
        rake: "ruby",
        // Ruby
        rb: "ruby",

        rbw: "ruby",
        rs: "rust",
        rst: "rst",
        sass: "sass",
        scala: "scala",
        scm: "scheme",
        scss: "scss",
        // Shell
        sh: "shell",
        // SQL
        sql: "sql",

        sqlite: "sql",
        stylus: "stylus",

        svg: "xml",
        swift: "swift",
        tcl: "tcl",
        tex: "latex",
        toml: "toml",
        ts: "typescript",
        tsv: "text",
        tsx: "tsx",
        twig: "twig",
        vb: "vb",
        vue: "vue",
        xhtml: "html",
        xml: "xml",
        xsl: "xml",
        xslt: "xml",
        yaml: "yaml",
        yml: "yaml",
        zig: "zig",
        zsh: "shell",
    };

    return langMap[extension || ""] || "text";
};

const TextAttachmentEditorDialog: FC<TextAttachmentEditorDialogProps> = ({ file, onOpenChange, onUpdate, open }) => {
    const { i18n, t } = useLingui();
    const [mode, setMode] = useState<"preview" | "edit">("preview");
    const [content, setContent] = useState<string>("");
    const [originalContent, setOriginalContent] = useState<string>("");
    const [isLoading, setIsLoading] = useState(true);
    const [filename, setFilename] = useState(file.name);
    const [filenameError, setFilenameError] = useState<string | null>(null);

    const language = useMemo(() => detectLanguage(filename), [filename]);

    // Check if file is too large to preview/edit
    const isFileTooLarge = file.size > CONTEXT_ERROR_THRESHOLD;

    // Load file content
    useEffect(() => {
        if (!open || isFileTooLarge) {
            return undefined;
        }

        let isCancelled = false;

        const loadContent = async () => {
            setIsLoading(true);

            try {
                const text = await file.text();

                if (isCancelled) {
                    return;
                }

                setContent(text);
                setOriginalContent(text);
            } catch (error) {
                if (isCancelled) {
                    return;
                }

                console.error("Failed to load file content:", error);
                setContent(t`Error loading file content`);
            } finally {
                if (!isCancelled) {
                    setIsLoading(false);
                }
            }
        };

        loadContent();

        return () => {
            isCancelled = true;
        };
    }, [file, open, isFileTooLarge, t]);

    const validateFilename = useCallback(
        (name: string): boolean => {
            if (!name.trim()) {
                setFilenameError(t`Filename cannot be empty`);

                return false;
            }

            const extension = name.split(".").pop()?.toLowerCase();

            if (!extension || !ALLOWED_EXTENSIONS.has(extension)) {
                setFilenameError(t`Invalid file extension. Must be a text-based file.`);

                return false;
            }

            setFilenameError(null);

            return true;
        },
        [t],
    );

    const handleFilenameSave = useCallback(
        (newName: string) => {
            if (validateFilename(newName)) {
                setFilename(newName);
            } else {
                // Keep original filename if invalid
                setFilename(file.name);
            }
        },
        [validateFilename, file.name],
    );

    const handleFilenameCancel = useCallback(() => {
        setFilename(file.name);
        setFilenameError(null);
    }, [file.name]);

    const handleSave = useCallback(() => {
        // Validate filename before saving
        if (!validateFilename(filename)) {
            return;
        }

        if (content !== originalContent || filename !== file.name) {
            // Create new file with updated content and/or name
            const blob = new Blob([content], { type: file.type });
            const newFile = new File([blob], filename, { type: file.type });

            onUpdate(newFile);
            setOriginalContent(content);
        }

        onOpenChange(false);
    }, [content, originalContent, filename, file, onUpdate, onOpenChange, validateFilename]);

    const handleCancel = useCallback(() => {
        setContent(originalContent);
        onOpenChange(false);
    }, [originalContent, onOpenChange]);

    const hasChanges = content !== originalContent || filename !== file.name;

    const stats = useMemo(() => {
        const lines = content.split("\n").length;
        const chars = content.length;
        const words = content.trim().split(WHITESPACE_RE).filter(Boolean).length;
        const estimatedTokens = Math.ceil(chars / 4); // Rough estimate: 4 chars per token

        return { chars, estimatedTokens, lines, words };
    }, [content]);

    // Check if content exceeds context limits (only if file loaded)
    const contextWarning = useMemo(() => {
        if (isFileTooLarge || !content) {
            return null;
        }

        if (stats.chars >= CONTEXT_ERROR_THRESHOLD) {
            return {
                level: "error" as const,
                message: t`This file is too large (~${formatNumber(stats.estimatedTokens, i18n.locale)} tokens) and exceeds the model's context window. The model may not be able to process this file effectively.`,
            };
        }

        if (stats.chars >= CONTEXT_WARNING_THRESHOLD) {
            return {
                level: "warning" as const,
                message: t`This file is large (~${formatNumber(stats.estimatedTokens, i18n.locale)} tokens) and will consume a significant portion of the model's context window.`,
            };
        }

        return null;
    }, [stats, i18n.locale, t, isFileTooLarge, content]);

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogBackdrop />
            <DialogPopup className="flex h-[90vh] w-[95vw] max-w-6xl flex-col overflow-hidden p-0" showCloseButton={false}>
                {/* Header */}
                <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3 dark:border-neutral-800">
                    <div className="flex min-w-0 items-center gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-950">
                            <FileTextIcon className="size-5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="min-w-0 flex-1">
                            <InlineEdit
                                className="-mt-1 mb-1 -ml-3"
                                onCancel={handleFilenameCancel}
                                onSave={handleFilenameSave}
                                renderInput={(props) => (
                                    <div className="flex flex-1 flex-col gap-1">
                                        <input
                                            {...props}
                                            className={clsx(
                                                "rounded border bg-white px-2 py-1 text-base font-semibold dark:bg-neutral-900",
                                                "focus:ring-2 focus:outline-none",
                                                filenameError
                                                    ? "border-red-300 focus:ring-red-500 dark:border-red-800"
                                                    : "border-gray-300 focus:ring-blue-500 dark:border-neutral-700",
                                            )}
                                            onChange={(e) => {
                                                props.onChange(e);
                                                validateFilename(e.target.value);
                                            }}
                                        />
                                        {filenameError && <span className="text-xs text-red-600 dark:text-red-400">{filenameError}</span>}
                                    </div>
                                )}
                                value={filename}
                            />
                            <DialogDescription className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-400">
                                <span>
                                    <Plural one="# line" other="# lines" value={stats.lines} />
                                </span>
                                <span>•</span>
                                <span>
                                    <Plural one="# char" other="# chars" value={stats.chars} />
                                </span>
                                <span>•</span>
                                <span>
                                    ~<Plural one="# token" other="# tokens" value={stats.estimatedTokens} />
                                </span>
                                {hasChanges && (
                                    <>
                                        <span>•</span>
                                        <span className="font-medium text-blue-600 dark:text-blue-400">
                                            <Trans>Modified</Trans>
                                        </span>
                                    </>
                                )}
                            </DialogDescription>
                        </div>
                    </div>

                    <div className="flex items-center gap-1.5">
                        {/* Mode toggle */}
                        {!isFileTooLarge && (
                            <div className="flex items-center gap-0.5 rounded-lg bg-gray-100 p-0.5 dark:bg-neutral-900">
                                <Button
                                    className="h-7 gap-1.5 px-2.5 text-xs"
                                    onClick={() => setMode("preview")}
                                    size="sm"
                                    variant={mode === "preview" ? "default" : "ghost"}
                                >
                                    <EyeIcon className="size-3.5" />
                                    {t`Preview`}
                                </Button>
                                <Button
                                    className="h-7 gap-1.5 px-2.5 text-xs"
                                    onClick={() => setMode("edit")}
                                    size="sm"
                                    variant={mode === "edit" ? "default" : "ghost"}
                                >
                                    <EditIcon className="size-3.5" />
                                    {t`Edit`}
                                </Button>
                            </div>
                        )}

                        {/* Action buttons */}
                        {!isFileTooLarge && hasChanges && (
                            <>
                                <Button className="h-8 text-xs" onClick={handleCancel} size="sm" variant="ghost">
                                    {t`Discard`}
                                </Button>
                                <Button className="h-8 gap-1.5 text-xs" onClick={handleSave} size="sm" variant="default">
                                    <CheckIcon className="size-3.5" />
                                    {t`Save & Close`}
                                </Button>
                            </>
                        )}

                        <DialogClose render={<Button className="size-8" size="icon" variant="ghost" />}>
                            <XIcon className="size-4" />
                        </DialogClose>
                    </div>
                </div>

                {/* Context Warning Banner */}
                {contextWarning && (
                    <div
                        className={clsx(
                            "flex items-start gap-2.5 border-b px-4 py-2.5",
                            contextWarning.level === "error"
                                ? "border-red-200 bg-red-50 dark:border-red-900/50 dark:bg-red-950/30"
                                : "border-amber-200 bg-amber-50 dark:border-amber-900/50 dark:bg-amber-950/30",
                        )}
                    >
                        {contextWarning.level === "error" ? (
                            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-red-600 dark:text-red-400" />
                        ) : (
                            <InfoIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                        )}
                        <div className="min-w-0 flex-1">
                            <p
                                className={clsx(
                                    "text-sm leading-relaxed",
                                    contextWarning.level === "error" ? "text-red-800 dark:text-red-200" : "text-amber-800 dark:text-amber-200",
                                )}
                            >
                                {contextWarning.message}
                            </p>
                        </div>
                    </div>
                )}

                {/* Content */}
                <div className="min-h-0 flex-1 overflow-hidden">
                    {isFileTooLarge && (
                        <div className="flex h-full flex-col items-center justify-center gap-4 p-8">
                            <div className="flex size-16 items-center justify-center rounded-full bg-red-100 dark:bg-red-950/30">
                                <AlertTriangleIcon className="size-8 text-red-600 dark:text-red-400" />
                            </div>
                            <div className="max-w-md text-center">
                                <h3 className="mb-2 text-lg font-semibold text-gray-900 dark:text-gray-100">{t`File Too Large to Preview`}</h3>
                                <p className="text-sm leading-relaxed text-gray-600 dark:text-gray-400">
                                    {t`This file is too large (${(file.size / 1024).toFixed(0)} KB) to preview or edit in the browser. Files over ${(CONTEXT_ERROR_THRESHOLD / 1024).toFixed(0)} KB cannot be opened to prevent performance issues.`}
                                </p>
                                <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">
                                    {t`The file is still attached and will be sent with your message.`}
                                </p>
                            </div>
                            <Button onClick={() => onOpenChange(false)} size="sm" variant="default">
                                {t`Close`}
                            </Button>
                        </div>
                    )}
                    {!isFileTooLarge && isLoading && (
                        <div className="flex h-full items-center justify-center">
                            <div className="text-sm text-gray-500 dark:text-gray-400">{t`Loading...`}</div>
                        </div>
                    )}
                    {!isFileTooLarge && !isLoading && (
                        <AnimatePresence mode="wait">
                            {mode === "preview" ? (
                                <motion.div
                                    animate={{ opacity: 1 }}
                                    className="h-full w-full"
                                    exit={{ opacity: 0 }}
                                    initial={{ opacity: 0 }}
                                    key="preview"
                                    transition={{ duration: 0.15 }}
                                >
                                    <Suspense
                                        fallback={
                                            <div className="flex h-full items-center justify-center">
                                                <div className="text-sm text-gray-500">{t`Loading preview...`}</div>
                                            </div>
                                        }
                                    >
                                        <CanvasCodemirrorEditor
                                            className="h-full w-full"
                                            content={content}
                                            key={`preview-${language}`}
                                            language={language}
                                            readOnly
                                        />
                                    </Suspense>
                                </motion.div>
                            ) : (
                                <motion.div
                                    animate={{ opacity: 1 }}
                                    className="h-full w-full"
                                    exit={{ opacity: 0 }}
                                    initial={{ opacity: 0 }}
                                    key="edit"
                                    transition={{ duration: 0.15 }}
                                >
                                    <Suspense
                                        fallback={
                                            <div className="flex h-full items-center justify-center">
                                                <div className="text-sm text-gray-500">{t`Loading editor...`}</div>
                                            </div>
                                        }
                                    >
                                        <CanvasCodemirrorEditor
                                            className="h-full w-full"
                                            content={content}
                                            key={`edit-${language}`}
                                            language={language}
                                            onSave={setContent}
                                        />
                                    </Suspense>
                                </motion.div>
                            )}
                        </AnimatePresence>
                    )}
                </div>
            </DialogPopup>
        </Dialog>
    );
};

export { isEditable, TextAttachmentEditorDialog };
