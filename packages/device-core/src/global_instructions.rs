//! The global instruction files AI tools keep in the person's home folder, read for the rule-file editor's
//! "Import from this computer". Two tools, both started by a click in project settings and never by a chat:
//! `instructions_list` says which of the files exist (names and sizes, no contents) and `instructions_read` reads the
//! ones the person ticked. The request only ever PICKS from [`FILES`] by id; no path comes from it.
//!
//! Each file is resolved when the call is planned, so the prompt shows where a link really leads, and again when it
//! runs: a file that resolves elsewhere by then, or is another file there, is refused. The run checks against the
//! shared folders it was planned with AND those saved when it runs, and opens what it resolved without following a link
//! swapped in since or waiting on a FIFO, then reads only a regular file that is still the one approved (its device and
//! inode on Unix; Windows has no stable id in `std`, so there the open handle's real path must be the approved one, and
//! a named pipe cannot sit in the home folder). A file with another name (a hard link, which a shared folder could
//! hold) is refused on Unix; Windows does not check that. Links are followed one at a time, at most [`MAX_LINKS`], and
//! every place on the way (each link, each name, and where it ends) must be outside every shared folder (the agent can
//! write there, so it could re-point a link there), each link inside the home folder or owned by the system; on Windows
//! the same walk sees symbolic links and junctions, whatever `read_link` reads. It is read only when it ends at a
//! regular Markdown file inside the home folder of at most [`MAX_FILE_BYTES`]. One read returns what fits in one result
//! ([`MAX_OUTPUT_BYTES`]); a file that does not fit is named as left out, never cut.

use std::fs::{self, File, Metadata};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};

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

/// Which file a path names: its device and inode on Unix, nothing elsewhere.
type Identity = Option<(u64, u64)>;

fn identity(metadata: &Metadata) -> Identity {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        Some((metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;

        None
    }
}

/// Whether the file has another name: a hard link from a shared folder would let the agent write it, and no path
/// check sees that name. Unix only; Windows hard links stay a documented gap.
fn hard_linked(metadata: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        metadata.nlink() > 1
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;

        false
    }
}

const CHANGED: &str = "it changed after it was approved";
const HARD_LINKED: &str = "it has another name (a hard link)";

/// Where one file resolved, and which file it was there.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Resolved {
    Missing,
    Refused(&'static str),
    At(PathBuf, Identity),
}

/// A planned request: `read` is `None` for the list, else the ids picked, in [`FILES`] order. `resolved` is where
/// each of its files led when it was planned, which the prompt shows and the run must find again.
#[derive(Clone, Debug)]
pub struct Request {
    pub home: PathBuf,
    pub read: Option<Vec<&'static str>>,
    resolved: Vec<(&'static GlobalFile, Resolved)>,
    roots: Vec<PathBuf>,
}

/// The same approval: the same files, leading to the same places. The shared folders it was planned under are left
/// out, so sharing an unrelated folder while the prompt is open does not void it; one that covers a place on the way
/// changes `resolved`, and [`Request::run`] checks the planned and current folders again.
impl PartialEq for Request {
    fn eq(&self, other: &Self) -> bool {
        self.home == other.home && self.read == other.read && self.resolved == other.resolved
    }
}

impl Eq for Request {}

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
                    Resolved::At(real, _) if *real != path => {
                        format!("  {} (links to {})", path.display(), real.display())
                    }
                    Resolved::At(..) => format!("  {}", path.display()),
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

    /// Runs the request against the shared folders saved now (`current`, canonical) as well as those it was planned
    /// with: a JSON list in [`FILES`] order. A file that leads to the same place as one before it (a link such as
    /// `~/.claude/CLAUDE.md → ~/.codex/AGENTS.md`) names that one in `sameAs`, so the editor makes one draft of the two.
    pub fn run(&self, current: &[PathBuf]) -> String {
        let roots: Vec<PathBuf> = self.roots.iter().chain(current).cloned().collect();
        let mut opened_at: Vec<(PathBuf, &'static str)> = Vec::new();
        let mut entries: Vec<Value> = self
            .resolved
            .iter()
            .map(|(file, planned)| {
                let mut entry = json!({ "id": file.id, "name": file.name, "path": format!("~/{}", file.relative) });
                let now = resolve(&self.home, file, &roots);
                let place = match &now {
                    Resolved::At(real, _) => Some(real.clone()),
                    _ => None,
                };
                let opened = match now {
                    Resolved::At(real, approved) if now_matches(planned, &real, approved) => {
                        open(&self.home, &real, approved)
                    }
                    Resolved::Refused(reason) => Err(Resolved::Refused(reason)),
                    _ if now != *planned => Err(Resolved::Refused(CHANGED)),
                    other => Err(other),
                };

                // Hard links are refused, so only a link leads two names to one file: its real path says so.
                if let (Ok(_), Some(place)) = (&opened, place) {
                    match opened_at.iter().find(|(earlier, _)| *earlier == place) {
                        Some((_, first)) => entry["sameAs"] = json!(first),
                        None => opened_at.push((place, file.id)),
                    }
                }

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
                            }
                        }
                    }
                }

                entry
            })
            .collect();

        fit(&mut entries);

        Value::Array(entries).to_string()
    }
}

/// An entry without its text: a read becomes `left_out`, anything else stays as it is.
fn without_text(entry: &Value) -> Value {
    let mut bare = entry.clone();

    if bare
        .as_object_mut()
        .and_then(|object| object.remove("text"))
        .is_some()
    {
        bare["status"] = json!("left_out");
    }

    bare
}

/// Keeps a read's text only while the list, with every later entry at its text-less size, still fits in one result
/// ([`MAX_OUTPUT_BYTES`]): what does not fit is left out whole, and the list is never cut. Sizes are exact: compact
/// JSON is `[`, the entries joined by `,`, then `]`.
fn fit(entries: &mut [Value]) {
    let total = |entries: &[Value]| {
        2 + entries.len().saturating_sub(1)
            + entries
                .iter()
                .map(|entry| entry.to_string().len())
                .sum::<usize>()
    };
    let bare: Vec<usize> = entries
        .iter()
        .map(|entry| without_text(entry).to_string().len())
        .collect();
    let mut used = 2 + entries.len().saturating_sub(1);
    let mut rest: usize = bare.iter().sum();

    for (entry, bare) in entries.iter_mut().zip(bare) {
        rest -= bare;

        if entry.get("text").is_some() && used + entry.to_string().len() + rest > MAX_OUTPUT_BYTES {
            *entry = without_text(entry);
        }

        used += entry.to_string().len();
    }

    // Only a backstop: the reservation above already keeps the list within the cap.
    while total(entries) > MAX_OUTPUT_BYTES {
        match entries
            .iter_mut()
            .rev()
            .find(|entry| entry.get("text").is_some())
        {
            Some(entry) => *entry = without_text(entry),
            None => break,
        }
    }
}

/// Links followed on the way to one file; a longer chain, or a loop, is refused.
const MAX_LINKS: usize = 8;

const SHARED: &str = "it is in a folder shared with the assistant";
const OUTSIDE_HOME: &str = "it links outside the home folder";
const UNREADABLE: &str = "it could not be looked up (no permission or a read error)";

/// Follows `path` one name at a time, as the system would, so that every place on the way is seen: each name is
/// joined to its folder's real path and refused when that place is in a shared folder (the agent could re-point a
/// link there, or put one there), and each link must sit inside `home`. `Ok(None)` is a name that is not there.
/// The place returned is the real path of the last name, which is not a link.
fn walk(
    home: &Path,
    path: &Path,
    shared: impl Fn(&Path) -> bool,
) -> Result<Option<PathBuf>, &'static str> {
    let mut pending: Vec<PathBuf> = path
        .components()
        .rev()
        .map(|part| PathBuf::from(part.as_os_str()))
        .collect();
    let mut resolved = PathBuf::new();
    let mut links = 0;

    while let Some(part) = pending.pop() {
        match part.components().next() {
            Some(Component::Prefix(_)) => resolved = part,
            Some(Component::RootDir) => {
                // A rooted link target keeps the drive it was reached on (Windows); on Unix this is `/`.
                let mut root = PathBuf::new();

                if let Some(Component::Prefix(prefix)) = resolved.components().next() {
                    root.push(prefix.as_os_str());
                }

                root.push(Component::RootDir.as_os_str());
                resolved = root;
            }
            // `resolved` holds no link, so its parent is the real one; `..` after a file fails as it would for the
            // system.
            Some(Component::ParentDir) if resolved.is_dir() => {
                resolved.pop();
            }
            Some(Component::ParentDir) => return Ok(None),
            Some(Component::Normal(name)) => {
                // The folder's real path, in the same form as `home` and the shared roots (Windows: `\\?\`).
                let Some(folder) = looked_up(fs::canonicalize(&resolved))? else {
                    return Ok(None);
                };
                let here = folder.join(name);

                if shared(&here) {
                    return Err(SHARED);
                }

                match looked_up(fs::symlink_metadata(&here))? {
                    None => return Ok(None),
                    Some(metadata) if metadata.file_type().is_symlink() => {
                        links += 1;

                        if links > MAX_LINKS {
                            return Err("it goes through too many links");
                        }

                        if !here.starts_with(home) && !system_owned(&folder, &metadata) {
                            return Err(OUTSIDE_HOME);
                        }

                        let Some(target) = looked_up(fs::read_link(&here))? else {
                            return Ok(None);
                        };

                        resolved = folder;
                        // A relative target continues from the link's folder; a rooted one starts over.
                        pending.extend(
                            target
                                .components()
                                .rev()
                                .map(|part| PathBuf::from(part.as_os_str())),
                        );
                    }
                    Some(_) => resolved = here,
                }
            }
            Some(Component::CurDir) | None => {}
        }
    }

    // Windows keeps the spelling a name was reached by, but the handle's real path, checked on open, has the one on
    // disk.
    #[cfg(windows)]
    let resolved = fs::canonicalize(&resolved).unwrap_or(resolved);

    Ok(Some(resolved))
}

/// One lookup on the way: a name that is not there is `None`, any other failure (no permission, a read error) is
/// refused, so the prompt never says "not there" for a file that may well be.
fn looked_up<T>(result: io::Result<T>) -> Result<Option<T>, &'static str> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Ok(None)
        }
        Err(_) => Err(UNREADABLE),
    }
}

/// A link outside the home folder that no one but the system can change: it and its folder belong to root, and the
/// folder is not writable by anyone else (`/home -> var/home`, a link in the Nix store). Windows follows none.
fn system_owned(folder: &Path, link: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;

        link.uid() == 0
            && fs::metadata(folder)
                .is_ok_and(|folder| folder.uid() == 0 && folder.mode() & 0o022 == 0)
    }
    #[cfg(not(unix))]
    {
        let _ = (folder, link);

        false
    }
}

/// Where one allowlisted file leads. Links are followed by [`walk`], which refuses a chain with any link or place in
/// a shared folder; the file it ends at must be a regular Markdown file inside `home` (already canonical) and not in
/// a shared folder either.
fn resolve(home: &Path, file: &GlobalFile, roots: &[PathBuf]) -> Resolved {
    let shared = |place: &Path| roots.iter().any(|root| place.starts_with(root));
    let real = match walk(home, &home.join(file.relative), shared) {
        Ok(Some(real)) => real,
        Ok(None) => return Resolved::Missing,
        Err(reason) => return Resolved::Refused(reason),
    };

    if !real.starts_with(home) {
        return Resolved::Refused(OUTSIDE_HOME);
    }

    if shared(&real) {
        return Resolved::Refused(SHARED);
    }

    if !real
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("md"))
    {
        return Resolved::Refused("it links to a file that is not Markdown");
    }

    match fs::metadata(&real) {
        Ok(metadata) if metadata.is_file() && hard_linked(&metadata) => {
            Resolved::Refused(HARD_LINKED)
        }
        Ok(metadata) if metadata.is_file() => Resolved::At(real, identity(&metadata)),
        _ => Resolved::Refused("it is not a regular file"),
    }
}

fn now_matches(planned: &Resolved, real: &Path, approved: Identity) -> bool {
    matches!(planned, Resolved::At(path, id) if path == real && *id == approved)
}

/// Opens a resolved file (`real`, canonical, inside `home`) without following a link swapped in since it resolved
/// and without waiting on a FIFO, then takes it only if the open handle is a regular file and the very one approved.
/// The size is the handle's. On Unix the walk down from `/` follows no link and the dev/inode must match; Windows has
/// no such id in `std`, so there the handle's real path must be `real` itself.
fn open(home: &Path, real: &Path, approved: Identity) -> Result<(File, u64), Resolved> {
    let within = if cfg!(unix) { home } else { real };
    let handle = crate::fs::open_confined(&[within.to_owned()], real).map_err(|error| {
        Resolved::Refused(if is_swapped_link(&error) {
            CHANGED
        } else {
            "it could not be opened"
        })
    })?;
    let metadata = handle
        .metadata()
        .map_err(|_| Resolved::Refused("it could not be opened"))?;

    if !metadata.is_file() {
        return Err(Resolved::Refused("it is not a regular file"));
    }

    if identity(&metadata) != approved {
        return Err(Resolved::Refused(CHANGED));
    }

    if hard_linked(&metadata) {
        return Err(Resolved::Refused(HARD_LINKED));
    }

    Ok((handle, metadata.len()))
}

/// A link, or anything but a folder, where a folder or the file was (`O_NOFOLLOW` and `O_DIRECTORY` refuse it), or, on
/// Windows, a handle whose real path is not the approved one.
fn is_swapped_link(error: &io::Error) -> bool {
    #[cfg(unix)]
    {
        matches!(error.raw_os_error(), Some(libc::ELOOP | libc::ENOTDIR))
    }
    #[cfg(not(unix))]
    {
        error.kind() == io::ErrorKind::PermissionDenied
    }
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
    use crate::test_dir::TestDir;

    /// A scratch folder per test, with a `home` inside it, so "outside home" is a real place.
    fn home(name: &str) -> (TestDir, PathBuf) {
        let dir = TestDir::new(&format!("global-instructions-{name}")).canonical();
        fs::create_dir_all(dir.join("home")).unwrap();
        let home = dir.join("home");

        (dir, home)
    }

    fn put(home: &Path, relative: &str, text: &str) {
        let path = home.join(relative);

        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    fn entries(request: &Request) -> Vec<Value> {
        serde_json::from_str::<Vec<Value>>(&request.run(&[])).unwrap()
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

    #[cfg(unix)]
    #[test]
    fn names_the_earlier_file_a_link_leads_to() {
        let (_dir, home) = home("same-as");

        put(&home, ".codex/AGENTS.md", "shared");
        put(&home, ".gemini/GEMINI.md", "shared");
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(
            home.join(".codex/AGENTS.md"),
            home.join(".claude/CLAUDE.md"),
        )
        .unwrap();

        let listed = entries(&plan(LIST_TOOL, &json!({}), Some(home.clone()), &[]).unwrap());
        let same: Vec<_> = listed.iter().map(|entry| entry["sameAs"].clone()).collect();

        // The first of the two keeps its place; equal text in another file is another file.
        assert_eq!(
            same,
            [Value::Null, json!("claude"), Value::Null, Value::Null]
        );

        let got = read(&home, &["codex", "claude"]);

        assert_eq!(got[1]["sameAs"], json!("claude"));
        assert_eq!(got[1]["text"], json!("shared"));
        // Read on its own, the link's target names nothing.
        assert!(read(&home, &["codex"])[0].get("sameAs").is_none());
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
        .run(&[]);
        let got: Vec<Value> = serde_json::from_str(&output).unwrap();

        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert_eq!(got[0]["status"], json!("read"));
        assert_eq!(got[1]["status"], json!("left_out"));
        assert!(got[1].get("text").is_none());
        assert_eq!(got[2]["text"], json!("small"));
    }

    fn read_entry(id: &str, length: usize) -> Value {
        json!({ "id": id, "name": "X.md", "path": "~/x/X.md", "size": length, "status": "read", "text": "a".repeat(length) })
    }

    /// Entries without text after a read: what the old budget appended unchecked.
    fn after() -> Vec<Value> {
        vec![
            json!({ "id": "codex", "name": "AGENTS.md", "path": "~/.codex/AGENTS.md", "status": "missing" }),
            json!({ "id": "gemini", "name": "GEMINI.md", "path": "~/.gemini/GEMINI.md", "status": "refused", "reason": CHANGED }),
            json!({ "id": "windsurf", "name": "global_rules.md", "path": "~/.codeium/windsurf/memories/global_rules.md", "status": "missing" }),
        ]
    }

    fn fitted(length: usize) -> (String, Vec<Value>) {
        let mut entries = vec![read_entry("claude", length)];

        entries.extend(after());
        fit(&mut entries);

        let output = Value::Array(entries).to_string();
        let got = serde_json::from_str(&output).unwrap();

        (output, got)
    }

    /// The longest read that still fits with [`after`]: the whole list is then exactly the cap.
    fn longest_fitting() -> usize {
        let mut entries = vec![read_entry("claude", 0)];

        entries.extend(after());

        let mut length = MAX_OUTPUT_BYTES - Value::Array(entries).to_string().len();

        while fitted(length).1[0]["status"] != json!("read") {
            length -= 1;
        }

        length
    }

    #[test]
    fn keeps_a_read_that_fits_with_the_entries_after_it() {
        let length = longest_fitting();
        let (output, got) = fitted(length);

        assert_eq!(output.len(), MAX_OUTPUT_BYTES);
        assert_eq!(got[0]["status"], json!("read"));
        assert_eq!(got[0]["text"].as_str().unwrap().len(), length);
    }

    #[test]
    fn leaves_out_a_read_that_fits_alone_but_not_with_the_entries_after_it() {
        let length = longest_fitting() + 1;
        // Alone it fits, so only the room kept for the later entries leaves it out.
        assert!(
            Value::Array(vec![read_entry("claude", length)])
                .to_string()
                .len()
                <= MAX_OUTPUT_BYTES
        );

        let (output, got) = fitted(length);

        assert!(output.len() <= MAX_OUTPUT_BYTES);
        assert_eq!(got[0]["status"], json!("left_out"));
        assert!(got[0].get("text").is_none());
        assert_eq!(got[0]["size"], json!(length));
        assert_eq!(
            got[1..]
                .iter()
                .map(|entry| entry["status"].clone())
                .collect::<Vec<_>>(),
            [json!("missing"), json!("refused"), json!("missing")]
        );
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
        let got: Vec<Value> = serde_json::from_str(&request.run(&[])).unwrap();

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
            .run(&[]),
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

    /// A link in a shared folder halfway along: the agent could re-point it at any Markdown file in home.
    #[cfg(unix)]
    #[test]
    fn refuses_a_chain_through_a_link_in_a_shared_folder() {
        use std::os::unix::fs::{symlink, PermissionsExt};

        let (dir, home) = home("shared-middle");

        put(&home, "notes/private.md", "private");
        fs::create_dir_all(home.join("work")).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        symlink(home.join("notes/private.md"), home.join("work/claude.md")).unwrap();
        symlink(home.join("work/claude.md"), home.join(".claude/CLAUDE.md")).unwrap();
        // A link outside home on the way back in: no longer a place the home-folder rule covers.
        // Its folder is writable by anyone, so it is no system link even when the suite runs as root.
        fs::create_dir_all(home.join(".codex")).unwrap();
        fs::create_dir_all(dir.join("hops")).unwrap();
        fs::set_permissions(dir.join("hops"), fs::Permissions::from_mode(0o777)).unwrap();
        symlink(home.join("notes/private.md"), dir.join("hops/hop.md")).unwrap();
        symlink(dir.join("hops/hop.md"), home.join(".codex/AGENTS.md")).unwrap();

        let got: Vec<Value> = serde_json::from_str(
            &plan(
                READ_TOOL,
                &json!({ "files": ["claude", "codex"] }),
                Some(home.clone()),
                &[home.join("work")],
            )
            .unwrap()
            .run(&[]),
        )
        .unwrap();

        assert_eq!(got[0]["reason"], json!(SHARED));
        assert_eq!(got[1]["reason"], json!(OUTSIDE_HOME));
        assert!(got.iter().all(|entry| entry.get("text").is_none()));
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_chain_of_links_outside_the_shared_folders() {
        use std::os::unix::fs::symlink;

        let (_dir, home) = home("chain");

        put(&home, "dotfiles/real/claude.md", "mine");
        fs::create_dir_all(home.join("work")).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        // Relative targets, one with `..`, resolved from each link's own folder.
        symlink("real/claude.md", home.join("dotfiles/claude.md")).unwrap();
        symlink("../dotfiles/claude.md", home.join(".claude/CLAUDE.md")).unwrap();

        let request = plan(
            READ_TOOL,
            &json!({ "files": ["claude"] }),
            Some(home.clone()),
            &[home.join("work")],
        )
        .unwrap();
        let got: Vec<Value> = serde_json::from_str(&request.run(&[])).unwrap();

        assert_eq!(got[0]["text"], json!("mine"));
        assert!(request.detail().contains(&format!(
            "(links to {})",
            home.join("dotfiles/real/claude.md").display()
        )));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_loop_and_a_chain_past_the_link_limit() {
        use std::os::unix::fs::symlink;

        let (_dir, home) = home("too-many");

        fs::create_dir_all(home.join(".claude")).unwrap();
        symlink(home.join("loop.md"), home.join(".claude/CLAUDE.md")).unwrap();
        symlink(home.join(".claude/CLAUDE.md"), home.join("loop.md")).unwrap();

        put(&home, "chain/end.md", "end");
        fs::create_dir_all(home.join(".codex")).unwrap();
        symlink(home.join("chain/end.md"), home.join("chain/0.md")).unwrap();

        for hop in 1..MAX_LINKS {
            symlink(
                home.join(format!("chain/{}.md", hop - 1)),
                home.join(format!("chain/{hop}.md")),
            )
            .unwrap();
        }

        // The whole limit still reads; one more link does not.
        fs::create_dir_all(home.join(".gemini")).unwrap();
        symlink(
            home.join(format!("chain/{}.md", MAX_LINKS - 2)),
            home.join(".gemini/GEMINI.md"),
        )
        .unwrap();
        symlink(
            home.join(format!("chain/{}.md", MAX_LINKS - 1)),
            home.join(".codex/AGENTS.md"),
        )
        .unwrap();

        let got = read(&home, &["claude", "codex", "gemini"]);

        assert_eq!(got[0]["reason"], json!("it goes through too many links"));
        assert_eq!(got[1]["reason"], json!("it goes through too many links"));
        assert_eq!(got[2]["text"], json!("end"));
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

        let got: Vec<Value> = serde_json::from_str(&request.run(&[])).unwrap();

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

    /// The approved file at `relative`, as `resolve` saw it.
    #[cfg(unix)]
    fn approved(home: &Path, relative: &str) -> (PathBuf, Identity) {
        let real = home.join(relative);

        (real.clone(), identity(&fs::metadata(&real).unwrap()))
    }

    #[cfg(unix)]
    fn refusal(opened: Result<(File, u64), Resolved>) -> Resolved {
        opened.map(|_| ()).unwrap_err()
    }

    #[cfg(unix)]
    #[test]
    fn refuses_another_file_put_at_the_approved_path() {
        let (_dir, home) = home("replaced");

        put(&home, ".claude/CLAUDE.md", "approved");

        let request = plan(
            READ_TOOL,
            &json!({ "files": ["claude"] }),
            Some(home.clone()),
            &[],
        )
        .unwrap();

        // Moved aside, not deleted: a freed inode number can be handed straight to the new file.
        fs::rename(home.join(".claude/CLAUDE.md"), home.join("old.md")).unwrap();
        put(&home, ".claude/CLAUDE.md", "swapped in");

        let got: Vec<Value> = serde_json::from_str(&request.run(&[])).unwrap();

        assert_eq!(got[0]["reason"], json!(CHANGED));
        assert!(got[0].get("text").is_none());
    }

    /// A swap between the run's own check and its open: the open handle decides, never the path.
    #[cfg(unix)]
    #[test]
    fn opens_only_the_approved_file_when_it_is_swapped_after_the_check() {
        let (dir, home) = home("swap-open");
        let relative = ".claude/CLAUDE.md";

        put(&home, relative, "approved");
        put(&home, "other.md", "another file");

        // Another regular file at the same path.
        let (real, id) = approved(&home, relative);

        fs::rename(home.join("other.md"), &real).unwrap();
        assert_eq!(refusal(open(&home, &real, id)), Resolved::Refused(CHANGED));

        // A link at the path, even to a file inside home.
        let (real, id) = approved(&home, relative);

        fs::remove_file(&real).unwrap();
        put(&home, "notes/x.md", "linked");
        std::os::unix::fs::symlink(home.join("notes/x.md"), &real).unwrap();
        assert_eq!(refusal(open(&home, &real, id)), Resolved::Refused(CHANGED));

        // A folder on the way swapped for a link out of home.
        fs::remove_file(&real).unwrap();
        put(&home, relative, "approved");

        let (real, id) = approved(&home, relative);

        put(&dir, "outside/CLAUDE.md", "secret");
        fs::rename(home.join(".claude"), home.join("claude-old")).unwrap();
        std::os::unix::fs::symlink(dir.join("outside"), home.join(".claude")).unwrap();
        assert_eq!(refusal(open(&home, &real, id)), Resolved::Refused(CHANGED));
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_swapped_in_after_the_check_does_not_block_the_open() {
        let (_dir, home) = home("swap-fifo");
        let relative = ".claude/CLAUDE.md";

        put(&home, relative, "approved");

        let (real, id) = approved(&home, relative);

        fs::remove_file(&real).unwrap();

        let name = std::ffi::CString::new(real.as_os_str().as_encoded_bytes()).unwrap();

        // SAFETY: a valid NUL-terminated path; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(name.as_ptr(), 0o600) }, 0);
        // No writer ever opens it: a blocking open would hang this test.
        assert_eq!(
            refusal(open(&home, &real, id)),
            Resolved::Refused("it is not a regular file")
        );
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_file_in_a_folder_shared_after_the_plan() {
        let (_dir, home) = home("shared-later");

        put(&home, "work/claude.md", "agent-written");
        fs::create_dir_all(home.join(".claude")).unwrap();
        std::os::unix::fs::symlink(home.join("work/claude.md"), home.join(".claude/CLAUDE.md"))
            .unwrap();

        let request = plan(
            READ_TOOL,
            &json!({ "files": ["claude"] }),
            Some(home.clone()),
            &[],
        )
        .unwrap();
        let replanned = |roots: &[PathBuf]| {
            plan(
                READ_TOOL,
                &json!({ "files": ["claude"] }),
                Some(home.clone()),
                roots,
            )
            .unwrap()
        };

        // Planned again for the approval check: an unrelated folder shared keeps it, the one on the way does not.
        fs::create_dir_all(home.join("elsewhere")).unwrap();
        assert_eq!(replanned(&[home.join("elsewhere")]), request);
        assert_ne!(replanned(&[home.join("work")]), request);

        let got: Vec<Value> = serde_json::from_str(&request.run(&[home.join("work")])).unwrap();

        assert_eq!(
            got[0]["reason"],
            json!("it is in a folder shared with the assistant")
        );
        assert!(got[0].get("text").is_none());
    }

    /// A folder the person cannot search is a refusal they can act on, not a file that is not there.
    #[cfg(unix)]
    #[test]
    fn a_lookup_without_permission_is_refused_not_missing() {
        use std::os::unix::fs::PermissionsExt;

        // SAFETY: geteuid has no preconditions. Root searches any folder, so there is nothing to refuse.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }

        let (_dir, home) = home("unsearchable");

        put(&home, ".claude/CLAUDE.md", "private");
        fs::set_permissions(home.join(".claude"), fs::Permissions::from_mode(0o600)).unwrap();

        let got = read(&home, &["claude", "codex"]);

        fs::set_permissions(home.join(".claude"), fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(got[0]["status"], json!("refused"));
        assert_eq!(got[0]["reason"], json!(UNREADABLE));
        assert_eq!(got[1]["status"], json!("missing"));
    }

    /// The folder lookup (`canonicalize`) and the link read (`read_link`) report a failure the same way: only a name
    /// that is not there is missing. Neither fails on its own once the name's own lookup passed, short of a change in
    /// between, so the mapping is checked directly; the link read is also checked on a real link that cannot be read.
    #[test]
    fn a_lookup_or_link_read_error_is_refused_not_missing() {
        let failed = |kind| looked_up::<()>(Err(io::Error::from(kind)));

        assert_eq!(failed(io::ErrorKind::NotFound), Ok(None));
        assert_eq!(failed(io::ErrorKind::NotADirectory), Ok(None));
        assert_eq!(failed(io::ErrorKind::PermissionDenied), Err(UNREADABLE));
        assert_eq!(failed(io::ErrorKind::Other), Err(UNREADABLE));
    }

    /// `/proc/1/cwd` is a link root owns in a folder only root can change (so it may be followed), and only root may
    /// read where it leads. Skipped where that is not so (root, or a container whose first process is ours).
    #[cfg(target_os = "linux")]
    #[test]
    fn a_link_that_cannot_be_read_is_refused_not_missing() {
        let unreadable = Path::new("/proc/1/cwd");

        if !fs::read_link(unreadable)
            .is_err_and(|error| error.kind() == io::ErrorKind::PermissionDenied)
        {
            return;
        }

        let (_dir, home) = home("unreadable-link");

        std::os::unix::fs::symlink(unreadable, home.join(".claude")).unwrap();

        let got = read(&home, &["claude"]);

        assert_eq!(got[0]["status"], json!("refused"));
        assert_eq!(got[0]["reason"], json!(UNREADABLE));
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_hard_link_into_a_shared_folder() {
        let (_dir, home) = home("hard-link");

        put(&home, "work/claude.md", "agent-written");
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::hard_link(home.join("work/claude.md"), home.join(".claude/CLAUDE.md")).unwrap();

        let request = plan(
            READ_TOOL,
            &json!({ "files": ["claude"] }),
            Some(home.clone()),
            &[home.join("work")],
        )
        .unwrap();
        let got: Vec<Value> = serde_json::from_str(&request.run(&[])).unwrap();

        assert_eq!(got[0]["reason"], json!(HARD_LINKED));
        assert!(got[0].get("text").is_none());

        // Linked after the check: the open handle is refused too.
        put(&home, ".codex/AGENTS.md", "mine");

        let (real, id) = approved(&home, ".codex/AGENTS.md");

        fs::hard_link(&real, home.join("work/agents.md")).unwrap();
        assert_eq!(
            refusal(open(&home, &real, id)),
            Resolved::Refused(HARD_LINKED)
        );
    }
}
