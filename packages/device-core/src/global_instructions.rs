//! The global instruction files AI tools keep in the person's home folder, read for the rule-file editor's
//! "Import from this computer". Two tools, both started by a click in project settings and never by a chat:
//! `instructions_list` says which of the files exist (names and sizes, no contents) and `instructions_read` reads the
//! ones the person ticked. The request only ever PICKS from [`FILES`] by id; no path comes from it.
//!
//! Each file is resolved when the call is planned, so the prompt shows where a link really leads, and again when it
//! runs: a file that resolves elsewhere by then is refused. It is read only when it resolves, links followed, to a
//! regular Markdown file inside the home folder and outside every shared folder (the agent can write there), and is
//! at most [`MAX_FILE_BYTES`]. One read returns what fits in one result ([`MAX_OUTPUT_BYTES`]); a file that does not
//! fit is named as left out, never cut.

use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::actions::MAX_OUTPUT_BYTES;

/// One allowlisted file: the id a request names and its place under the home folder.
pub struct GlobalFile {
    pub id: &'static str,
    pub name: &'static str,
    pub relative: &'static str,
}

/// Every file these tools may touch. Nothing else is ever resolved.
pub const FILES: &[GlobalFile] = &[
    GlobalFile {
        id: "claude",
        name: "CLAUDE.md",
        relative: ".claude/CLAUDE.md",
    },
    GlobalFile {
        id: "codex",
        name: "AGENTS.md",
        relative: ".codex/AGENTS.md",
    },
    GlobalFile {
        id: "gemini",
        name: "GEMINI.md",
        relative: ".gemini/GEMINI.md",
    },
    GlobalFile {
        id: "windsurf",
        name: "global_rules.md",
        relative: ".codeium/windsurf/memories/global_rules.md",
    },
];

/// Bytes of one file; a larger one is listed as too large and never read.
pub const MAX_FILE_BYTES: u64 = 48 * 1024;

pub const LIST_TOOL: &str = "instructions_list";
pub const READ_TOOL: &str = "instructions_read";

pub fn is_global_instructions_tool(tool: &str) -> bool {
    tool == LIST_TOOL || tool == READ_TOOL
}

/// Where one file resolved.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Resolved {
    Missing,
    Refused(&'static str),
    At(PathBuf),
}

/// A planned request: `read` is `None` for the list, else the ids picked, in [`FILES`] order. `resolved` is where
/// each of its files led when it was planned, which the prompt shows and the run must find again.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Request {
    pub home: PathBuf,
    pub read: Option<Vec<&'static str>>,
    resolved: Vec<(&'static GlobalFile, Resolved)>,
    roots: Vec<PathBuf>,
}

impl PartialEq for GlobalFile {
    fn eq(&self, other: &Self) -> bool {
        self.id == other.id
    }
}

impl Eq for GlobalFile {}

impl std::fmt::Debug for GlobalFile {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.id)
    }
}

/// Plans `tool` against `home` (the canonical home folder) and the shared `roots` (canonical). The read names ids
/// only: an unknown one, a repeat, a path or an empty pick refuses the whole call.
pub fn plan(
    tool: &str,
    input: &Value,
    home: Option<PathBuf>,
    roots: &[PathBuf],
) -> Result<Request, String> {
    let home = home.ok_or("the home folder could not be found")?;
    let read = if tool == LIST_TOOL {
        None
    } else {
        Some(picked_ids(input)?)
    };
    let resolved = FILES
        .iter()
        .filter(|file| read.as_ref().is_none_or(|ids| ids.contains(&file.id)))
        .map(|file| (file, resolve(&home, file, roots)))
        .collect();

    Ok(Request {
        home,
        read,
        resolved,
        roots: roots.to_vec(),
    })
}

fn picked_ids(input: &Value) -> Result<Vec<&'static str>, String> {
    let picked = input
        .get("files")
        .and_then(Value::as_array)
        .filter(|files| !files.is_empty() && files.len() <= FILES.len())
        .ok_or("pick between one and four files")?;
    let mut ids = Vec::with_capacity(picked.len());

    for value in picked {
        let file = value
            .as_str()
            .and_then(|id| FILES.iter().find(|file| file.id == id))
            .ok_or("only the listed instruction files can be read")?;

        if ids.contains(&file.id) {
            return Err("a file was picked twice".into());
        }

        ids.push(file.id);
    }

    ids.sort_by_key(|id| FILES.iter().position(|file| file.id == *id));

    Ok(ids)
}

impl Request {
    /// The prompt's text: exactly which files, by full path, where a link really leads, and whether their contents
    /// leave the computer.
    pub fn detail(&self) -> String {
        let lines = self
            .resolved
            .iter()
            .map(|(file, resolved)| {
                let path = self.home.join(file.relative);

                match resolved {
                    Resolved::At(real) if *real != path => {
                        format!("  {} (links to {})", path.display(), real.display())
                    }
                    Resolved::At(_) => format!("  {}", path.display()),
                    Resolved::Missing => format!("  {} (not there)", path.display()),
                    Resolved::Refused(reason) => {
                        format!("  {} (refused: {reason})", path.display())
                    }
                }
            })
            .collect::<Vec<_>>()
            .join("\n");

        match self.read {
            None => format!(
                "Check which of these instruction files exist (names and sizes only, no contents):\n{lines}"
            ),
            Some(_) => format!("Send the contents of these instruction files to Neore:\n{lines}"),
        }
    }

    /// Runs the request: a JSON list in [`FILES`] order.
    pub fn run(&self) -> String {
        let mut used = 2;
        let entries: Vec<Value> = self
            .resolved
            .iter()
            .map(|(file, planned)| {
                let mut entry = json!({ "id": file.id, "name": file.name, "path": format!("~/{}", file.relative) });
                let now = resolve(&self.home, file, &self.roots);
                let opened = match now {
                    _ if now != *planned => Err(Resolved::Refused("it changed after it was approved")),
                    Resolved::At(real) => open(&real),
                    other => Err(other),
                };

                match (opened, &self.read) {
                    (Err(Resolved::Refused(reason)), _) => {
                        entry["status"] = json!("refused");
                        entry["reason"] = json!(reason);
                    }
                    (Err(_), _) => entry["status"] = json!("missing"),
                    (Ok((_, size)), _) if size > MAX_FILE_BYTES => {
                        entry["size"] = json!(size);
                        entry["status"] = json!("too_large");
                    }
                    (Ok((_, size)), None) => {
                        entry["size"] = json!(size);
                        entry["status"] = json!("found");
                    }
                    (Ok((handle, size)), Some(_)) => {
                        entry["size"] = json!(size);

                        match read_text(handle) {
                            Err(reason) => {
                                entry["status"] = json!("refused");
                                entry["reason"] = json!(reason);
                            }
                            Ok(text) => {
                                entry["status"] = json!("read");
                                entry["text"] = json!(text);

                                // What does not fit in this one result is left out whole, never cut.
                                let length = entry.to_string().len() + 1;

                                if used + length > MAX_OUTPUT_BYTES {
                                    entry
                                        .as_object_mut()
                                        .map(|object| object.remove("text"));
                                    entry["status"] = json!("left_out");
                                }
                            }
                        }
                    }
                }

                used += entry.to_string().len() + 1;

                entry
            })
            .collect();

        Value::Array(entries).to_string()
    }
}

/// Where one allowlisted file leads. Links are followed, but the file they end at must be a regular Markdown file
/// inside `home` (already canonical); neither it nor the link may sit in a shared folder, where the agent could
/// change it or re-point it.
fn resolve(home: &Path, file: &GlobalFile, roots: &[PathBuf]) -> Resolved {
    let path = home.join(file.relative);

    if fs::symlink_metadata(&path).is_err() {
        return Resolved::Missing;
    }

    let Ok(real) = fs::canonicalize(&path) else {
        return Resolved::Missing;
    };
    // The link itself, its folders resolved: a folder linked into a shared one puts the link there.
    let link = path
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        .map(|parent| parent.join(file.name));

    if !real.starts_with(home) {
        return Resolved::Refused("it links outside the home folder");
    }

    let shared = |place: &Path| roots.iter().any(|root| place.starts_with(root));

    if shared(&real) || link.as_deref().is_some_and(shared) {
        return Resolved::Refused("it is in a folder shared with the assistant");
    }

    if !real
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Resolved::Refused("it links to a file that is not Markdown");
    }

    // Before any open: opening a FIFO would wait for a writer.
    if !fs::metadata(&real).is_ok_and(|metadata| metadata.is_file()) {
        return Resolved::Refused("it is not a regular file");
    }

    Resolved::At(real)
}

/// Opens a resolved file; the size is the open handle's, so a file swapped in after the check is the one measured.
fn open(real: &Path) -> Result<(File, u64), Resolved> {
    let handle = File::open(real).map_err(|_| Resolved::Refused("it could not be opened"))?;
    let metadata = handle
        .metadata()
        .map_err(|_| Resolved::Refused("it could not be opened"))?;

    if !metadata.is_file() {
        return Err(Resolved::Refused("it is not a regular file"));
    }

    Ok((handle, metadata.len()))
}

fn read_text(handle: File) -> Result<String, &'static str> {
    let mut bytes = Vec::new();

    handle
        .take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "it could not be read")?;

    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err("it grew past the size limit");
    }

    String::from_utf8(bytes).map_err(|_| "it is not UTF-8 text")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A scratch folder per test, with a `home` inside it, so "outside home" is a real place.
    fn home(name: &str) -> (PathBuf, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "neore-global-instructions-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("home")).unwrap();
        let dir = fs::canonicalize(dir).unwrap();

        (dir.clone(), dir.join("home"))
    }

    fn put(home: &Path, relative: &str, text: &str) {
        let path = home.join(relative);

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn entries(request: &Request) -> Vec<Value> {
        serde_json::from_str::<Vec<Value>>(&request.run()).unwrap()
    }

    fn read(home: &Path, ids: &[&str]) -> Vec<Value> {
        entries(
            &plan(
                READ_TOOL,
                &json!({ "files": ids }),
                Some(home.to_owned()),
                &[],
            )
            .unwrap(),
        )
    }

    #[test]
    fn lists_names_and_sizes_without_contents() {
        let (_dir, home) = home("list");

        put(&home, ".claude/CLAUDE.md", "be brief");
        put(&home, ".gemini/GEMINI.md", "x");

        let listed =
            entries(&plan(LIST_TOOL, &json!({ "files": ["../x"] }), Some(home), &[]).unwrap());
        let statuses: Vec<_> = listed.iter().map(|entry| entry["status"].clone()).collect();

        assert_eq!(
            statuses,
            [
                json!("found"),
                json!("missing"),
                json!("found"),
                json!("missing")
            ]
        );
        assert_eq!(listed[0]["size"], json!(8));
        assert_eq!(
            listed[3]["path"],
            json!("~/.codeium/windsurf/memories/global_rules.md")
        );
        assert!(listed.iter().all(|entry| entry.get("text").is_none()));
    }

    #[test]
    fn reads_only_the_picked_files_in_list_order() {
        let (_dir, home) = home("picked");

        put(&home, ".claude/CLAUDE.md", "one");
        put(&home, ".codex/AGENTS.md", "two");

        let got = read(&home, &["codex", "claude"]);

        assert_eq!(got.len(), 2);
        assert_eq!(
            (got[0]["id"].clone(), got[0]["text"].clone()),
            (json!("claude"), json!("one"))
        );
        assert_eq!(
            (got[1]["id"].clone(), got[1]["text"].clone()),
            (json!("codex"), json!("two"))
        );
    }

    #[test]
    fn refuses_anything_but_listed_ids() {
        let (_dir, home) = home("refuse");
        let refused = |input: Value| plan(READ_TOOL, &input, Some(home.clone()), &[]).unwrap_err();

        for input in [
            json!({ "files": ["~/.ssh/id_ed25519"] }),
            json!({ "files": ["/etc/passwd"] }),
            json!({ "files": [".claude/CLAUDE.md"] }),
            json!({ "files": ["CLAUDE"] }),
            json!({ "files": [7] }),
        ] {
            assert_eq!(
                refused(input),
                "only the listed instruction files can be read"
            );
        }

        assert_eq!(
            refused(json!({ "files": ["claude", "claude"] })),
            "a file was picked twice"
        );
        assert_eq!(
            refused(json!({ "files": [] })),
            "pick between one and four files"
        );
        assert_eq!(
            refused(json!({ "path": "/etc/passwd" })),
            "pick between one and four files"
        );
        assert!(plan(LIST_TOOL, &json!({}), None, &[]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_link_out_of_the_home_folder() {
        let (dir, home) = home("link-out");
        let outside = dir.join("secret.txt");

        fs::write(&outside, "secret").unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(&outside, home.join(".claude/CLAUDE.md")).unwrap();
        // A folder linked out of home counts the same as a file.
        std::os::unix::fs::symlink(&dir, home.join(".codex")).unwrap();
        fs::write(dir.join("AGENTS.md"), "secret").unwrap();

        let got = read(&home, &["claude", "codex"]);

        for entry in &got {
            assert_eq!(entry["status"], json!("refused"));
            assert_eq!(entry["reason"], json!("it links outside the home folder"));
            assert!(entry.get("text").is_none() && entry.get("size").is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_link_that_stays_inside_home() {
        let (_dir, home) = home("link-in");

        put(&home, "dotfiles/claude.md", "mine");
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(
            home.join("dotfiles/claude.md"),
            home.join(".claude/CLAUDE.md"),
        )
        .unwrap();

        assert_eq!(read(&home, &["claude"])[0]["text"], json!("mine"));
    }

    #[test]
    fn refuses_a_folder_a_large_file_and_binary_text() {
        let (_dir, home) = home("kinds");

        fs::create_dir_all(home.join(".claude/CLAUDE.md")).unwrap();
        put(
            &home,
            ".codex/AGENTS.md",
            &"a".repeat(MAX_FILE_BYTES as usize + 1),
        );
        fs::create_dir_all(home.join(".gemini")).unwrap();
        fs::write(home.join(".gemini/GEMINI.md"), [0xff, 0xfe]).unwrap();

        let got = read(&home, &["claude", "codex", "gemini"]);

        assert_eq!(got[0]["reason"], json!("it is not a regular file"));
        assert_eq!(got[1]["status"], json!("too_large"));
        assert!(got[1].get("text").is_none());
        assert_eq!(got[2]["reason"], json!("it is not UTF-8 text"));
    }

    #[test]
    fn leaves_out_whole_files_past_one_result() {
        let (_dir, home) = home("budget");
        let big = "b".repeat(MAX_FILE_BYTES as usize - 10);

        put(&home, ".claude/CLAUDE.md", &big);
        put(&home, ".codex/AGENTS.md", &big);
        put(&home, ".gemini/GEMINI.md", "small");

        let output = plan(
            READ_TOOL,
            &json!({ "files": ["claude", "codex", "gemini"] }),
            Some(home),
            &[],
        )
        .unwrap()
        .run();
        let got: Vec<Value> = serde_json::from_str(&output).unwrap();

        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert_eq!(got[0]["status"], json!("read"));
        assert_eq!(got[1]["status"], json!("left_out"));
        assert!(got[1].get("text").is_none());
        assert_eq!(got[2]["text"], json!("small"));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_link_to_a_secret_inside_home_and_names_where_links_lead() {
        let (_dir, home) = home("secret");

        put(&home, ".ssh/id_ed25519", "PRIVATE KEY");
        put(&home, "notes/claude.md", "mine");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::create_dir_all(home.join(".codex")).unwrap();
        std::os::unix::fs::symlink(home.join(".ssh/id_ed25519"), home.join(".claude/CLAUDE.md"))
            .unwrap();
        std::os::unix::fs::symlink(home.join("notes/claude.md"), home.join(".codex/AGENTS.md"))
            .unwrap();

        let request = plan(
            READ_TOOL,
            &json!({ "files": ["claude", "codex"] }),
            Some(home.clone()),
            &[],
        )
        .unwrap();
        let detail = request.detail();
        let got: Vec<Value> = serde_json::from_str(&request.run()).unwrap();

        assert_eq!(
            got[0]["reason"],
            json!("it links to a file that is not Markdown")
        );
        assert!(got[0].get("text").is_none() && got[0].get("size").is_none());
        assert_eq!(got[1]["text"], json!("mine"));
        assert!(detail.contains("(refused: it links to a file that is not Markdown)"));
        assert!(detail.contains(&format!(
            "(links to {})",
            home.join("notes/claude.md").display()
        )));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_files_in_a_shared_folder_and_links_placed_there() {
        let (_dir, home) = home("shared");
        let shared = home.join("work");

        put(&home, "work/claude.md", "agent-written");
        put(&home, "work/dot-codex/AGENTS.md", "agent-written");
        put(&home, "notes/private.md", "private");
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(home.join("work/claude.md"), home.join(".claude/CLAUDE.md"))
            .unwrap();
        // A folder linked INTO the shared folder: the agent could re-point the link inside it.
        std::os::unix::fs::symlink(home.join("work/dot-codex"), home.join(".codex")).unwrap();

        let got: Vec<Value> = serde_json::from_str(
            &plan(
                READ_TOOL,
                &json!({ "files": ["claude", "codex"] }),
                Some(home.clone()),
                &[shared],
            )
            .unwrap()
            .run(),
        )
        .unwrap();

        for entry in &got {
            assert_eq!(
                entry["reason"],
                json!("it is in a folder shared with the assistant")
            );
            assert!(entry.get("text").is_none());
        }
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_file_that_resolves_elsewhere_after_the_approval() {
        let (_dir, home) = home("moved");

        put(&home, "a/claude.md", "approved");
        put(&home, "b/claude.md", "swapped in");
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(home.join("a/claude.md"), home.join(".claude/CLAUDE.md"))
            .unwrap();

        let request = plan(
            READ_TOOL,
            &json!({ "files": ["claude"] }),
            Some(home.clone()),
            &[],
        )
        .unwrap();

        fs::remove_file(home.join(".claude/CLAUDE.md")).unwrap();
        std::os::unix::fs::symlink(home.join("b/claude.md"), home.join(".claude/CLAUDE.md"))
            .unwrap();

        let got: Vec<Value> = serde_json::from_str(&request.run()).unwrap();

        assert_eq!(got[0]["reason"], json!("it changed after it was approved"));
        assert!(got[0].get("text").is_none());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_fifo_without_waiting_on_it() {
        let (_dir, home) = home("fifo");
        let path = home.join(".claude/CLAUDE.md");

        fs::create_dir_all(home.join(".claude")).unwrap();

        let name = std::ffi::CString::new(path.as_os_str().as_encoded_bytes()).unwrap();

        // SAFETY: a valid NUL-terminated path; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);

        let listed = entries(&plan(LIST_TOOL, &json!({}), Some(home), &[]).unwrap());

        assert_eq!(listed[0]["reason"], json!("it is not a regular file"));
    }
}
