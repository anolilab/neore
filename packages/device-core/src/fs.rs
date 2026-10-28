//! Local files, confined to the folders the user allowed.
//!
//! Every path is resolved against the CANONICAL roots: symlinks are followed
//! before the check, so neither `..` nor a symlink inside a root can reach
//! outside it. A path that does not exist yet (a write) is checked through its
//! canonical parent plus a plain file name.
//!
//! Resolving happens when a call is PLANNED, before the person is asked, so the
//! path can change while the prompt is open. The operations therefore re-confine
//! at USE time: on Unix every component below the shared root is opened with
//! `O_NOFOLLOW` (see `confined`), so a symlink swapped in since planning fails
//! instead of being followed. Windows opens the target first and then checks
//! the real path of the open handle against the roots.

use std::fs;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use serde_json::{json, Value};

use crate::media::{self, Kind};

/// Largest file `fs_read` opens and `fs_write` writes.
pub const MAX_FILE_BYTES: u64 = 1024 * 1024;
/// Directory entries `fs_list` returns.
pub const MAX_LIST_ENTRIES: usize = 1000;
/// Entries one page of [`list_page`] returns at most.
pub const MAX_PAGE_ENTRIES: usize = 2000;
/// Entries of one folder [`list_page`] reads before it says the folder was cut.
const MAX_FOLDER_ENTRIES: usize = 1_000_000;

/// The roots that still exist, canonicalised. Missing folders are skipped.
pub fn canonical_roots(roots: &[String]) -> Vec<PathBuf> {
    roots
        .iter()
        .filter_map(|root| fs::canonicalize(root).ok())
        .filter(|root| root.is_dir())
        .collect()
}

fn within_roots(path: &Path, roots: &[PathBuf]) -> bool {
    roots.iter().any(|root| path.starts_with(root))
}

/// A path from the model: absolute, or relative to the first root.
fn candidate(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let raw = raw.trim();
    let root = roots
        .first()
        .ok_or("no folders are shared with the agent")?;

    if raw.is_empty() || raw == "." {
        return Ok(root.clone());
    }

    if raw.contains('\0') {
        return Err("invalid path".into());
    }

    let path = Path::new(raw);

    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
}

/// An EXISTING path inside a root.
pub fn resolve_existing(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let resolved =
        fs::canonicalize(candidate(raw, roots)?).map_err(|_| format!("{raw}: not found"))?;

    if !within_roots(&resolved, roots) {
        return Err(format!("{raw}: outside the shared folders"));
    }

    Ok(resolved)
}

/// A path to WRITE: its parent must exist inside a root, its name must be a
/// plain file name, and if it already exists it must itself resolve inside.
pub fn resolve_for_write(raw: &str, roots: &[PathBuf]) -> Result<PathBuf, String> {
    let path = candidate(raw, roots)?;
    let name = match path.components().next_back() {
        Some(Component::Normal(name)) => name.to_owned(),
        _ => return Err(format!("{raw}: not a file name")),
    };
    let parent = path
        .parent()
        .ok_or_else(|| format!("{raw}: no parent folder"))?;
    let parent =
        fs::canonicalize(parent).map_err(|_| format!("{raw}: the folder does not exist"))?;

    if !within_roots(&parent, roots) {
        return Err(format!("{raw}: outside the shared folders"));
    }

    let target = parent.join(name);

    if fs::symlink_metadata(&target).is_ok() {
        let real = fs::canonicalize(&target).map_err(|_| format!("{raw}: cannot resolve"))?;

        if !within_roots(&real, roots) {
            return Err(format!("{raw}: outside the shared folders"));
        }

        if real.is_dir() {
            return Err(format!("{raw}: is a folder"));
        }

        // A link inside the roots is written through: the plan (and so the prompt) carries the file it points to,
        // like `resolve_existing` does for reads. The use-time walk follows no links, so it could not open the link.
        return Ok(real);
    }

    Ok(target)
}

/// Whether a reparse tag names another place (symlink, junction): bit 29 of the tag. Other tags (cloud placeholders,
/// deduplicated files, ...) are ordinary files and folders whose content a filter driver supplies.
#[cfg(any(windows, test))]
fn is_name_surrogate(tag: u32) -> bool {
    tag & 0x2000_0000 != 0
}

/// How a file is opened by [`confined::open_file`].
#[derive(Clone, Copy)]
enum Open {
    Read,
    /// Fails if the name exists.
    Create,
    Overwrite,
}

/// `(name, kind, size)` per entry, and whether the listing was cut.
type Listing = (Vec<(String, &'static str, u64)>, bool);

/// One page of a folder in name order: its entries, whether more follow, and whether the folder was cut short.
struct Page {
    cut: bool,
    entries: Vec<(String, &'static str, u64)>,
    more: bool,
}

fn outside_roots() -> io::Error {
    io::Error::new(
        io::ErrorKind::PermissionDenied,
        "outside the shared folders",
    )
}

#[cfg(unix)]
mod confined {
    use super::{outside_roots, Listing, Open, Page};
    use std::collections::BinaryHeap;
    use std::ffi::{CString, OsStr};
    use std::fs::File;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Component, Path, PathBuf};

    /// The thread's `errno`, which `readdir` leaves alone at the end of a folder and sets on an error.
    pub(crate) fn errno() -> *mut libc::c_int {
        // SAFETY: each of these returns the address of the calling thread's `errno`.
        #[cfg(any(target_os = "linux", target_os = "android", target_os = "emscripten"))]
        unsafe {
            libc::__errno_location()
        }
        #[cfg(any(
            target_os = "macos",
            target_os = "ios",
            target_os = "freebsd",
            target_os = "dragonfly"
        ))]
        unsafe {
            libc::__error()
        }
        #[cfg(any(target_os = "netbsd", target_os = "openbsd"))]
        unsafe {
            libc::__errno()
        }
    }

    fn openat(dir: libc::c_int, name: &OsStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        let name = CString::new(name.as_bytes())
            .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
        // SAFETY: `name` is a NUL-terminated string that outlives the call; the fd is owned from here on.
        let fd = unsafe {
            libc::openat(
                dir,
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
                0o666 as libc::c_uint,
            )
        };

        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        // SAFETY: `fd` was just returned by `openat` and nothing else owns it.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// How a component that is only passed through is opened: search permission is enough to traverse a folder, so a
    /// shared folder under a `0711` parent still works. Linux has `O_PATH`, macOS `O_SEARCH`; elsewhere a plain read.
    #[cfg(any(target_os = "linux", target_os = "android"))]
    const SEARCH: libc::c_int = libc::O_PATH | libc::O_DIRECTORY;
    #[cfg(target_vendor = "apple")]
    const SEARCH: libc::c_int = libc::O_SEARCH;
    #[cfg(not(any(target_os = "linux", target_os = "android", target_vendor = "apple")))]
    const SEARCH: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY;

    fn traverse(dir: libc::c_int, name: &OsStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        openat(dir, name, flags).or_else(|error| {
            // An older kernel that does not know the search-only flag: a plain read still follows no link.
            if flags == SEARCH && error.raw_os_error() == Some(libc::EINVAL) {
                openat(dir, name, libc::O_RDONLY | libc::O_DIRECTORY)
            } else {
                Err(error)
            }
        })
    }

    /// Opens `path` (canonical, inside one of `roots`) by walking down from `/` one component at a time, never
    /// following a symlink: `O_NOFOLLOW` only guards the last component of a path, so the root's own ancestors are
    /// walked the same way. One swapped for a link since the path was resolved fails with `ELOOP`.
    ///
    /// Every component is opened search-only except the last when `readable` (a folder to list), which needs read.
    pub fn open_dir(roots: &[PathBuf], path: &Path, readable: bool) -> io::Result<OwnedFd> {
        if !roots.iter().any(|root| path.starts_with(root)) {
            return Err(outside_roots());
        }

        let mut names = Vec::new();

        for component in path.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => names.push(name),
                _ => return Err(outside_roots()),
            }
        }

        let mut dir = traverse(libc::AT_FDCWD, OsStr::new("/"), SEARCH)?;

        for (index, name) in names.iter().enumerate() {
            let flags = if readable && index + 1 == names.len() {
                libc::O_RDONLY | libc::O_DIRECTORY
            } else {
                SEARCH
            };

            dir = traverse(dir.as_raw_fd(), name, flags)?;
        }

        Ok(dir)
    }

    pub fn open_file(roots: &[PathBuf], path: &Path, how: Open) -> io::Result<File> {
        let (parent, name) = path
            .parent()
            .zip(path.file_name())
            .ok_or_else(outside_roots)?;
        let dir = open_dir(roots, parent, false)?;
        let flags = match how {
            // Non-blocking so a FIFO swapped in cannot hang the open.
            Open::Read => libc::O_RDONLY | libc::O_NONBLOCK,
            Open::Create => libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
            Open::Overwrite => libc::O_WRONLY | libc::O_CREAT | libc::O_TRUNC,
        };

        openat(dir.as_raw_fd(), name, flags).map(File::from)
    }

    /// A folder opened by [`open_dir`] and read through that descriptor.
    struct Stream {
        fd: libc::c_int,
        stream: *mut libc::DIR,
    }

    impl Stream {
        fn open(roots: &[PathBuf], path: &Path) -> io::Result<Stream> {
            let dir = open_dir(roots, path, true)?;
            let fd = dir.as_raw_fd();
            // SAFETY: `fdopendir` takes over `fd`, so the owner is forgotten and `closedir` (in `Drop`) closes it.
            let stream = unsafe { libc::fdopendir(fd) };

            if stream.is_null() {
                return Err(io::Error::last_os_error());
            }

            std::mem::forget(dir);

            Ok(Stream { fd, stream })
        }

        /// Calls `visit` with each name but `.` and `..` until it answers `false`. A read that fails partway is an
        /// error, not the end of the folder: a short listing would pass for a complete one.
        fn names(&mut self, mut visit: impl FnMut(&std::ffi::CStr) -> bool) -> io::Result<()> {
            loop {
                // SAFETY: `errno` is the calling thread's own; `stream` is a live DIR* until `closedir`, and the
                // entry is only read before the next call.
                let entry = unsafe {
                    *errno() = 0;

                    libc::readdir(self.stream)
                };

                if entry.is_null() {
                    // The end of the folder leaves `errno` alone; a failed read sets it.
                    let error = io::Error::last_os_error();

                    return match error.raw_os_error() {
                        Some(0) | None => Ok(()),
                        Some(_) => Err(error),
                    };
                }

                // SAFETY: `d_name` is a NUL-terminated string inside the entry returned above.
                let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };

                if !matches!(name.to_bytes(), b"." | b"..") && !visit(name) {
                    return Ok(());
                }
            }
        }

        /// What an entry is and its size, without following it.
        fn kind(fd: libc::c_int, name: &std::ffi::CStr) -> (&'static str, u64) {
            // SAFETY: an all-zero `stat` is a valid out-parameter; `fstatat` fills it.
            let mut stat: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: `fd` is still open (owned by `stream`) and `name` is NUL-terminated.
            let found =
                unsafe { libc::fstatat(fd, name.as_ptr(), &mut stat, libc::AT_SYMLINK_NOFOLLOW) }
                    == 0;

            match (found, stat.st_mode & libc::S_IFMT) {
                (false, _) => ("unknown", 0),
                (true, libc::S_IFLNK) => ("symlink", stat.st_size as u64),
                (true, libc::S_IFDIR) => ("dir", stat.st_size as u64),
                (true, _) => ("file", stat.st_size as u64),
            }
        }
    }

    impl Drop for Stream {
        fn drop(&mut self) {
            // SAFETY: `stream` came from `fdopendir` and is closed exactly once.
            unsafe { libc::closedir(self.stream) };
        }
    }

    /// `(name, kind, size)` of up to `max` entries of a directory, read through the descriptor that
    /// `open_dir` confined. The `bool` says whether there were more.
    pub fn entries(roots: &[PathBuf], path: &Path, max: usize) -> io::Result<Listing> {
        let mut stream = Stream::open(roots, path)?;
        let fd = stream.fd;
        let mut listed = Vec::new();
        let mut truncated = false;

        stream.names(|name| {
            if listed.len() >= max {
                truncated = true;

                return false;
            }

            let (kind, size) = Stream::kind(fd, name);

            listed.push((name.to_string_lossy().into_owned(), kind, size));

            true
        })?;

        Ok((listed, truncated))
    }

    /// The `limit` smallest names greater than `after`, with their kinds, and whether more follow. Every name is
    /// read but only `limit + 1` are kept, and only those are looked at with `fstatat`, so a page costs one pass
    /// over the folder's names and memory for one page, however large the folder is. At most `scan` names are
    /// read; `cut` says the folder had more.
    pub fn page(
        roots: &[PathBuf],
        path: &Path,
        after: Option<&str>,
        limit: usize,
        scan: usize,
    ) -> io::Result<Page> {
        let mut stream = Stream::open(roots, path)?;
        // Largest on top, so the one to give up is always at hand. Compared as text, like the sorted listing.
        let mut kept: BinaryHeap<(String, Vec<u8>)> = BinaryHeap::new();
        let (mut scanned, mut cut) = (0usize, false);

        stream.names(|name| {
            if scanned >= scan {
                cut = true;

                return false;
            }

            scanned += 1;

            let text = String::from_utf8_lossy(name.to_bytes());

            if after.is_some_and(|after| text.as_ref() <= after) {
                return true;
            }

            if kept.len() <= limit {
                kept.push((text.into_owned(), name.to_bytes().to_vec()));
            } else if kept
                .peek()
                .is_some_and(|largest| text.as_ref() < largest.0.as_str())
            {
                kept.pop();
                kept.push((text.into_owned(), name.to_bytes().to_vec()));
            }

            true
        })?;

        let fd = stream.fd;
        let mut names = kept.into_sorted_vec();
        let more = names.len() > limit;

        names.truncate(limit);

        let entries = names
            .into_iter()
            .map(|(text, raw)| {
                let (kind, size) = std::ffi::CString::new(raw)
                    .map_or(("unknown", 0), |raw| Stream::kind(fd, &raw));

                (text, kind, size)
            })
            .collect();

        Ok(Page { cut, entries, more })
    }
}

/// Windows has no `openat`, so the check is bound to the HANDLE instead: the target is opened first (reparse points
/// opened as themselves, never followed, and without sharing delete/rename so the folders above it cannot be moved
/// while it is open), then `GetFinalPathNameByHandleW` names what was really opened and it must lie inside a root.
/// A parent swapped for a link after planning therefore resolves outside and is refused. A write that creates a new
/// file can still create it at a swapped-in place before the check; the file is then removed again.
#[cfg(windows)]
mod confined {
    use super::{outside_roots, within_roots, Listing, Open, Page};
    use std::ffi::OsString;
    use std::fs::{File, OpenOptions};
    use std::io;
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle};
    use std::path::{Path, PathBuf};

    use windows_sys::Win32::Foundation::INVALID_HANDLE_VALUE;
    use windows_sys::Win32::Storage::FileSystem::{
        FileAttributeTagInfo, FileDispositionInfo, FileIdBothDirectoryInfo,
        FileIdBothDirectoryRestartInfo, GetFileInformationByHandleEx, GetFinalPathNameByHandleW,
        ReOpenFile, SetFileInformationByHandle, FILE_ATTRIBUTE_DIRECTORY,
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_ATTRIBUTE_TAG_INFO, FILE_DISPOSITION_INFO,
        FILE_ID_BOTH_DIR_INFO,
    };

    const DELETE: u32 = 0x0001_0000;
    const GENERIC_READ: u32 = 0x8000_0000;
    const GENERIC_WRITE: u32 = 0x4000_0000;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;

    /// The real path of an open handle (`\\?\C:\...`, the same form `canonicalize` gives the roots).
    fn final_path(file: &File) -> io::Result<PathBuf> {
        let mut buffer = vec![0u16; 1024];

        loop {
            // SAFETY: the handle is open for the duration of the call and the buffer length is passed with it.
            let length = unsafe {
                GetFinalPathNameByHandleW(
                    file.as_raw_handle(),
                    buffer.as_mut_ptr(),
                    buffer.len() as u32,
                    0,
                )
            } as usize;

            if length == 0 {
                return Err(io::Error::last_os_error());
            }

            if length < buffer.len() {
                return Ok(PathBuf::from(OsString::from_wide(&buffer[..length])));
            }

            buffer.resize(length + 1, 0);
        }
    }

    /// The real path of `file` if it is inside a root and not itself a link.
    fn confirm(file: &File, roots: &[PathBuf]) -> io::Result<PathBuf> {
        let real = final_path(file)?;

        if !within_roots(&real, roots) || reparse_tag(file)?.is_some_and(super::is_name_surrogate) {
            return Err(outside_roots());
        }

        Ok(real)
    }

    /// The reparse tag of an open handle, if it has one.
    fn reparse_tag(file: &File) -> io::Result<Option<u32>> {
        let mut info = FILE_ATTRIBUTE_TAG_INFO {
            FileAttributes: 0,
            ReparseTag: 0,
        };

        // SAFETY: the handle is open and `info` is a `FILE_ATTRIBUTE_TAG_INFO` of the size passed.
        let read = unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileAttributeTagInfo,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of::<FILE_ATTRIBUTE_TAG_INFO>() as u32,
            )
        };

        if read == 0 {
            return Err(io::Error::last_os_error());
        }

        Ok((info.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0).then_some(info.ReparseTag))
    }

    /// Reopens the file object `file` is open on, this time letting a filter driver process its reparse point.
    fn reopen(file: &File, access: u32, flags: u32) -> io::Result<File> {
        // SAFETY: the handle is open; the result is checked before use and owned by the `File` made from it.
        let reopened = unsafe {
            ReOpenFile(
                file.as_raw_handle(),
                access,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                flags,
            )
        };

        if reopened == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        // SAFETY: `reopened` is a valid handle nothing else owns.
        Ok(unsafe { File::from_raw_handle(reopened) })
    }

    /// `file` was opened as itself (`FILE_FLAG_OPEN_REPARSE_POINT`) and passed `confirm`, so a link is already
    /// refused. A cloud placeholder or deduplicated file is not a link, but its content only arrives when the
    /// reparse point is processed: reopen that same file object that way and check the new handle again.
    fn with_content(file: File, roots: &[PathBuf], access: u32) -> io::Result<File> {
        if reparse_tag(&file)?.is_none() {
            return Ok(file);
        }

        let reopened = reopen(&file, access, FILE_FLAG_BACKUP_SEMANTICS)?;

        confirm(&reopened, roots)?;

        Ok(reopened)
    }

    fn options(write: bool) -> OpenOptions {
        let mut options = OpenOptions::new();

        options
            .read(!write)
            .write(write)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS);

        options
    }

    pub fn open_file(roots: &[PathBuf], path: &Path, how: Open) -> io::Result<File> {
        match how {
            Open::Read => {
                let file = options(false).open(path)?;

                confirm(&file, roots)?;

                with_content(file, roots, GENERIC_READ)
            }
            Open::Create => create(roots, path),
            Open::Overwrite => match options(true).open(path) {
                Ok(file) => {
                    // Truncate only once the handle is known to be inside a root.
                    confirm(&file, roots)?;

                    let file = with_content(file, roots, GENERIC_WRITE)?;

                    file.set_len(0)?;

                    Ok(file)
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => create(roots, path),
                Err(error) => Err(error),
            },
        }
    }

    fn create(roots: &[PathBuf], path: &Path) -> io::Result<File> {
        // No DELETE access: a folder that lets a user write but not delete must keep working. Sharing delete lets
        // the cleanup below reopen THIS file object with DELETE should the check fail.
        let file = options(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .create_new(true)
            .open(path)?;

        match confirm(&file, roots) {
            Ok(_) => Ok(file),
            Err(error) => {
                remove_through_handle(&file);

                Err(error)
            }
        }
    }

    /// Deletes the file `file` is open on, through a delete-capable reopen of that same file object, never by path
    /// (a path could name another file by now). If the reopen is refused the empty file is left behind and logged;
    /// the call is refused either way.
    fn remove_through_handle(file: &File) {
        let reopened = match reopen(file, DELETE, FILE_FLAG_OPEN_REPARSE_POINT) {
            Ok(reopened) => reopened,
            Err(error) => {
                eprintln!(
                    "[device-core] could not remove a file created outside the shared folders: {error}"
                );

                return;
            }
        };
        let disposition = FILE_DISPOSITION_INFO { DeleteFile: true };

        // SAFETY: the handle is open and the buffer is a `FILE_DISPOSITION_INFO` of the size passed.
        let marked = unsafe {
            SetFileInformationByHandle(
                reopened.as_raw_handle(),
                FileDispositionInfo,
                std::ptr::from_ref(&disposition).cast(),
                std::mem::size_of::<FILE_DISPOSITION_INFO>() as u32,
            )
        };

        if marked == 0 {
            eprintln!(
                "[device-core] could not mark a file created outside the shared folders for deletion: {}",
                io::Error::last_os_error()
            );
        }
    }

    /// Lists the folder through the handle that was checked, so there is no second path to resolve. The directory
    /// info classes report attributes without following anything: a reparse point is listed as a link.
    pub fn entries(roots: &[PathBuf], path: &Path, max: usize) -> io::Result<Listing> {
        let dir = options(false).open(path)?;

        confirm(&dir, roots)?;

        let dir = with_content(dir, roots, GENERIC_READ)?;

        // 8-byte aligned, as the entries are.
        let mut buffer = vec![0u64; 8192];
        let mut class = FileIdBothDirectoryRestartInfo;
        let mut listed = Vec::new();
        let mut truncated = false;

        'read: loop {
            // SAFETY: the handle is open and the buffer is writable for the length passed.
            let read = unsafe {
                GetFileInformationByHandleEx(
                    dir.as_raw_handle(),
                    class,
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * 8) as u32,
                )
            };

            if read == 0 {
                let error = io::Error::last_os_error();

                // ERROR_NO_MORE_FILES: the end of the folder.
                return if error.raw_os_error() == Some(18) {
                    Ok((listed, truncated))
                } else {
                    Err(error)
                };
            }

            class = FileIdBothDirectoryInfo;

            let mut offset = 0usize;

            loop {
                // SAFETY: the system wrote a chain of `FILE_ID_BOTH_DIR_INFO` records; each offset stays inside it.
                let entry = unsafe {
                    &*buffer
                        .as_ptr()
                        .cast::<u8>()
                        .add(offset)
                        .cast::<FILE_ID_BOTH_DIR_INFO>()
                };
                // SAFETY: `FileNameLength` bytes of UTF-16 follow the fixed part, inside the buffer.
                let name = unsafe {
                    std::slice::from_raw_parts(
                        std::ptr::addr_of!(entry.FileName).cast::<u16>(),
                        entry.FileNameLength as usize / 2,
                    )
                };
                let name = String::from_utf16_lossy(name);

                if name != "." && name != ".." {
                    if listed.len() >= max {
                        truncated = true;
                        break 'read;
                    }

                    // With a reparse point set, `EaSize` carries its tag. Only a name surrogate is a link.
                    let link = entry.FileAttributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
                        && super::is_name_surrogate(entry.EaSize);
                    let kind = if link {
                        "symlink"
                    } else if entry.FileAttributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                        "dir"
                    } else {
                        "file"
                    };

                    listed.push((name, kind, entry.EndOfFile.max(0) as u64));
                }

                if entry.NextEntryOffset == 0 {
                    break;
                }

                offset += entry.NextEntryOffset as usize;
            }
        }

        Ok((listed, truncated))
    }

    /// A page of the folder in name order. Windows lists a folder in one call that already carries every
    /// entry's attributes, so it is read whole (up to `scan` entries) and cut to the page.
    pub fn page(
        roots: &[PathBuf],
        path: &Path,
        after: Option<&str>,
        limit: usize,
        scan: usize,
    ) -> io::Result<Page> {
        let (mut listed, cut) = entries(roots, path, scan)?;

        listed.sort();
        listed.drain(
            ..after.map_or(0, |after| {
                listed.partition_point(|(name, _, _)| name.as_str() <= after)
            }),
        );

        let more = listed.len() > limit;

        listed.truncate(limit);

        Ok(Page {
            cut,
            entries: listed,
            more,
        })
    }
}

#[cfg(unix)]
pub(crate) use confined::errno;

/// A folder opened for reading through the same walk as [`list`], for a caller that goes on by descriptor.
#[cfg(unix)]
pub(crate) fn open_folder(roots: &[PathBuf], path: &Path) -> io::Result<std::os::fd::OwnedFd> {
    confined::open_dir(roots, path, true)
}

pub fn list(roots: &[PathBuf], path: &Path) -> Result<Value, String> {
    let (mut listed, truncated) =
        confined::entries(roots, path, MAX_LIST_ENTRIES).map_err(|error| error.to_string())?;

    listed.sort();

    let entries: Vec<Value> = listed
        .into_iter()
        .map(|(name, kind, size)| json!({ "name": name, "type": kind, "size": size }))
        .collect();

    Ok(json!({ "path": path.to_string_lossy(), "entries": entries, "truncated": truncated }))
}

/// One page of a folder, name-sorted: the entries after `after` (a name from the previous page's `next`), at most
/// `limit` of them. A page reads the folder's names but keeps and looks at only the page, so it costs a pass over
/// the folder and memory for the page; `fs_list` keeps its 1000-entry cut for the agent.
pub fn list_page(
    roots: &[PathBuf],
    path: &Path,
    after: Option<&str>,
    limit: usize,
) -> Result<Value, String> {
    let page = confined::page(roots, path, after, limit, MAX_FOLDER_ENTRIES)
        .map_err(|error| error.to_string())?;
    let next = page
        .more
        .then(|| page.entries.last().map(|(name, _, _)| name.as_str()))
        .flatten();
    let entries: Vec<Value> = page
        .entries
        .iter()
        .map(|(name, kind, size)| json!({ "name": name, "type": kind, "size": size }))
        .collect();

    Ok(
        json!({ "path": path.to_string_lossy(), "entries": entries, "next": next, "truncated": page.cut }),
    )
}

/// Up to [`MAX_FILE_BYTES`] of a file as text. Binary files are described, not dumped.
pub fn read(roots: &[PathBuf], path: &Path) -> Result<String, String> {
    if roots.iter().any(|root| root == path) {
        return Err("is a folder; use fs_list".into());
    }

    let file = confined::open_file(roots, path, Open::Read).map_err(|error| error.to_string())?;
    let meta = file.metadata().map_err(|error| error.to_string())?;

    if meta.is_dir() {
        return Err("is a folder; use fs_list".into());
    }

    let mut bytes = Vec::new();

    file.take(MAX_FILE_BYTES)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;

    if bytes.contains(&0) {
        return Ok(format!("[binary file, {} bytes]", meta.len()));
    }

    let mut text = String::from_utf8_lossy(&bytes).into_owned();

    if meta.len() > MAX_FILE_BYTES {
        text.push_str(&format!(
            "\n[… file is {} bytes; only the first {MAX_FILE_BYTES} were read]",
            meta.len()
        ));
    }

    Ok(text)
}

/// `raw` as a path inside `root`, decided on the text alone: `.` and `..` are folded without touching the disk, a
/// relative path is taken from the root, and the result must still start with it. Nothing is resolved, so a path
/// that names another machine (`/net/host/..`, an automounted or network path) is refused before the system could
/// connect to it, which `canonicalize` would do.
fn lexically_inside(root: &Path, raw: &str) -> Option<PathBuf> {
    let path = Path::new(raw.trim());
    let mut folded = PathBuf::new();

    for component in root.join(path).components() {
        match component {
            Component::ParentDir => {
                folded.pop();
            }
            Component::CurDir => {}
            other => folded.push(other.as_os_str()),
        }
    }

    folded.starts_with(root).then_some(folded)
}

/// A file the agent wrote, read for attaching to its reply.
#[derive(Debug)]
pub struct MediaFile {
    pub bytes: Vec<u8>,
    pub kind: Kind,
    pub mime: &'static str,
    pub name: String,
    pub size: u64,
}

/// What reading one reference came to. Only `Read` carries bytes.
#[derive(Debug)]
pub enum MediaRead {
    Read(MediaFile),
    /// Over the upload cap: named, never read past its first bytes.
    TooLarge {
        mime: &'static str,
        name: String,
        size: u64,
    },
    /// Outside the folder, not a plain file, not an allowed type, or not there. Says nothing about which.
    Refused,
}

/// A file the agent's reply refers to, if it is inside `roots` and an allowed type (`media`). `reference` is the
/// path as the reply wrote it: relative to the first root, or absolute.
///
/// A path that resolves outside the roots is refused by the canonicalisation, which opens nothing: `..`, an
/// absolute path elsewhere and a link that leaves the folder are all caught before any file is touched. What
/// passes is then opened through the same confined walk as `fs_read` (no link followed below the root, so a link
/// swapped in since the check fails), and its size is taken from the OPEN file, not from an earlier look.
pub fn read_media(roots: &[PathBuf], reference: &str) -> MediaRead {
    if !media::is_plain_path(reference) {
        return MediaRead::Refused;
    }

    // The text first: a reference that leaves the folder is refused before anything resolves it.
    let Some(inside) = roots
        .iter()
        .find_map(|root| lexically_inside(root, reference))
    else {
        return MediaRead::Refused;
    };
    let Ok(path) = resolve_existing(&inside.to_string_lossy(), roots) else {
        return MediaRead::Refused;
    };
    let Some(name) = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
    else {
        return MediaRead::Refused;
    };
    let Ok(mut file) = confined::open_file(roots, &path, Open::Read) else {
        return MediaRead::Refused;
    };
    let Ok(meta) = file.metadata() else {
        return MediaRead::Refused;
    };

    if !meta.is_file() {
        return MediaRead::Refused;
    }

    let mut head = Vec::new();

    if (&mut file)
        .take(media::SNIFF_BYTES as u64)
        .read_to_end(&mut head)
        .is_err()
    {
        return MediaRead::Refused;
    }

    let Some((mime, kind)) = media::classify(&name, &head) else {
        return MediaRead::Refused;
    };
    let size = meta.len();

    if size > media::MAX_UPLOAD_BYTES {
        return MediaRead::TooLarge { mime, name, size };
    }

    // The rest, one byte past the cap so a file that grew since `fstat` is caught instead of truncated.
    let mut bytes = head;

    if file
        .take(media::MAX_UPLOAD_BYTES + 1 - bytes.len() as u64)
        .read_to_end(&mut bytes)
        .is_err()
    {
        return MediaRead::Refused;
    }

    if bytes.len() as u64 > media::MAX_UPLOAD_BYTES {
        return MediaRead::TooLarge {
            mime,
            name,
            size: bytes.len() as u64,
        };
    }

    let size = bytes.len() as u64;
    // An image above the inline cap is offered as a file, with its size.
    let kind = if kind == Kind::Image && size > media::MAX_INLINE_IMAGE_BYTES {
        Kind::File
    } else {
        kind
    };

    MediaRead::Read(MediaFile {
        bytes,
        kind,
        mime,
        name,
        size,
    })
}

pub fn write(
    roots: &[PathBuf],
    path: &Path,
    content: &str,
    overwrite: bool,
) -> Result<String, String> {
    if content.len() as u64 > MAX_FILE_BYTES {
        return Err("content is larger than 1 MiB".into());
    }

    let how = if overwrite {
        Open::Overwrite
    } else {
        Open::Create
    };
    let mut file = confined::open_file(roots, path, how).map_err(|error| match error.kind() {
        io::ErrorKind::AlreadyExists => {
            "the file exists; pass overwrite: true to replace it".to_owned()
        }
        _ => error.to_string(),
    })?;

    file.write_all(content.as_bytes())
        .map_err(|error| error.to_string())?;

    Ok(format!(
        "wrote {} bytes to {}",
        content.len(),
        path.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("neore-device-fs-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("root/sub")).unwrap();
        fs::write(dir.join("root/a.txt"), "hello").unwrap();
        fs::write(dir.join("secret.txt"), "nope").unwrap();
        dir
    }

    #[test]
    fn resolves_inside_and_refuses_dot_dot() {
        let dir = scratch("dotdot");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        assert!(resolve_existing("a.txt", &roots).is_ok());
        assert!(resolve_existing("sub/../a.txt", &roots).is_ok());
        assert!(resolve_existing("../secret.txt", &roots).is_err());
        assert!(resolve_existing(&dir.join("secret.txt").to_string_lossy(), &roots).is_err());
        assert!(resolve_for_write("../evil.txt", &roots).is_err());
        assert!(resolve_for_write("sub/new.txt", &roots).is_ok());
        assert!(resolve_for_write("missing/new.txt", &roots).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_that_escapes_a_root() {
        let dir = scratch("symlink");
        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("root/link.txt")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("root/up")).unwrap();
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        assert!(resolve_existing("link.txt", &roots).is_err());
        assert!(resolve_existing("up/secret.txt", &roots).is_err());
        assert!(resolve_for_write("link.txt", &roots).is_err());
        assert!(resolve_for_write("up/new.txt", &roots).is_err());
    }

    #[test]
    fn nothing_resolves_without_roots() {
        assert!(resolve_existing("a.txt", &[]).is_err());
    }

    #[test]
    fn write_refuses_to_clobber_unless_asked() {
        let dir = scratch("write");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);
        let target = resolve_for_write("a.txt", &roots).unwrap();

        assert!(write(&roots, &target, "x", false).is_err());
        assert!(write(&roots, &target, "x", true).is_ok());
        assert_eq!(read(&roots, &target).unwrap(), "x");
    }

    /// The path is checked when planned and a symlink can replace it while the prompt is open.
    #[cfg(unix)]
    #[test]
    fn a_symlink_swapped_in_after_planning_is_not_followed() {
        let dir = scratch("swap");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);
        let outside = dir.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("new.txt"), "untouched").unwrap();

        // Planned while `sub` is a plain folder and `a.txt` a plain file.
        let write_target = resolve_for_write("sub/new.txt", &roots).unwrap();
        let read_target = resolve_existing("a.txt", &roots).unwrap();
        let list_target = resolve_existing("sub", &roots).unwrap();

        // They are swapped for links to places outside the root.
        fs::remove_dir(dir.join("root/sub")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("root/sub")).unwrap();
        fs::remove_file(dir.join("root/a.txt")).unwrap();
        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("root/a.txt")).unwrap();

        assert!(write(&roots, &write_target, "pwned", true).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("new.txt")).unwrap(),
            "untouched"
        );
        assert!(read(&roots, &read_target).is_err());
        assert!(list(&roots, &list_target).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_final_component_symlink_is_not_overwritten() {
        let dir = scratch("final");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);
        let target = resolve_for_write("new.txt", &roots).unwrap();

        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("root/new.txt")).unwrap();

        assert!(write(&roots, &target, "pwned", false).is_err());
        assert!(write(&roots, &target, "pwned", true).is_err());
        assert_eq!(fs::read_to_string(dir.join("secret.txt")).unwrap(), "nope");
    }

    #[test]
    fn lists_and_reads_inside_a_root() {
        let dir = scratch("inside");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);
        let listing = list(&roots, &roots[0]).unwrap();
        let names: Vec<&str> = listing["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["name"].as_str().unwrap())
            .collect();

        assert_eq!(names, ["a.txt", "sub"]);
        assert_eq!(read(&roots, &roots[0].join("a.txt")).unwrap(), "hello");
        assert!(read(&roots, &roots[0]).is_err());
    }

    /// An ancestor of the root replaced by a link after the roots were read must not be followed.
    #[cfg(unix)]
    #[test]
    fn a_root_ancestor_swapped_for_a_symlink_is_not_followed() {
        let dir = scratch("ancestor");
        let outside = dir.join("outside");
        fs::create_dir_all(outside.join("inner")).unwrap();
        fs::write(outside.join("inner/a.txt"), "outside").unwrap();
        fs::create_dir_all(dir.join("parent/inner")).unwrap();
        fs::write(dir.join("parent/inner/a.txt"), "inside").unwrap();
        let roots = canonical_roots(&[dir.join("parent/inner").to_string_lossy().into_owned()]);
        let file = resolve_existing("a.txt", &roots).unwrap();

        assert_eq!(read(&roots, &file).unwrap(), "inside");

        // `parent` (an ancestor of the root) is swapped for a link to a look-alike tree.
        fs::rename(dir.join("parent"), dir.join("parent-moved")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("parent")).unwrap();

        assert!(read(&roots, &file).is_err());
        assert!(list(&roots, &roots[0]).is_err());
        assert!(write(&roots, &file, "pwned", true).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("inner/a.txt")).unwrap(),
            "outside"
        );
    }

    /// Traversal needs search permission only: a shared folder under a `0711` parent must stay usable.
    #[cfg(unix)]
    #[test]
    fn a_folder_under_a_search_only_ancestor_is_usable() {
        use std::os::unix::fs::PermissionsExt;

        // Root ignores permission bits, so there is nothing to show.
        if unsafe { libc::geteuid() } == 0 {
            return;
        }

        let dir = scratch("search-only");
        let ancestor = dir.join("acc");
        fs::create_dir_all(ancestor.join("root")).unwrap();
        fs::write(ancestor.join("root/a.txt"), "hello").unwrap();
        fs::set_permissions(&ancestor, fs::Permissions::from_mode(0o711)).unwrap();

        let roots = canonical_roots(&[ancestor.join("root").to_string_lossy().into_owned()]);
        let file = resolve_existing("a.txt", &roots).unwrap();
        let target = resolve_for_write("b.txt", &roots).unwrap();
        let outcome = (
            read(&roots, &file),
            write(&roots, &target, "x", false),
            list(&roots, &roots[0]).map(|listing| listing["entries"].as_array().unwrap().len()),
        );

        fs::set_permissions(&ancestor, fs::Permissions::from_mode(0o755)).unwrap();

        assert_eq!(outcome.0.unwrap(), "hello");
        assert!(outcome.1.is_ok());
        assert_eq!(outcome.2.unwrap(), 2);
    }

    /// A read and a write through a link that stays inside the roots both resolve to the file it points to.
    #[cfg(unix)]
    #[test]
    fn an_in_root_link_is_resolved_for_reads_and_writes_alike() {
        let dir = scratch("inlink");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        std::os::unix::fs::symlink(roots[0].join("a.txt"), dir.join("root/link.txt")).unwrap();

        let read_path = resolve_existing("link.txt", &roots).unwrap();
        let write_path = resolve_for_write("link.txt", &roots).unwrap();

        assert_eq!(read_path, roots[0].join("a.txt"));
        assert_eq!(write_path, read_path);
        assert_eq!(read(&roots, &read_path).unwrap(), "hello");
        assert!(write(&roots, &write_path, "x", true).is_ok());
        assert_eq!(fs::read_to_string(dir.join("root/a.txt")).unwrap(), "x");
    }

    const PNG_HEAD: [u8; 10] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0];

    fn media_scratch(name: &str) -> (PathBuf, Vec<PathBuf>) {
        let dir = scratch(name);

        fs::write(dir.join("root/chart.png"), PNG_HEAD).unwrap();
        fs::write(dir.join("secret.png"), PNG_HEAD).unwrap();

        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        (dir, roots)
    }

    #[test]
    fn an_image_in_the_folder_is_read_with_its_type() {
        let (_dir, roots) = media_scratch("media-ok");

        match read_media(&roots, "chart.png") {
            MediaRead::Read(file) => {
                assert_eq!(file.bytes, PNG_HEAD);
                assert_eq!(file.mime, "image/png");
                assert_eq!(file.kind, Kind::Image);
                assert_eq!(file.name, "chart.png");
                assert_eq!(file.size, PNG_HEAD.len() as u64);
            }
            other => panic!("{other:?}"),
        }
    }

    /// The outside files are made unreadable: a refusal that is an "outside the folder" answer, not a permission
    /// error from an open, proves the file was never opened.
    #[cfg(unix)]
    #[test]
    fn a_reference_that_leaves_the_folder_is_refused_without_opening_anything() {
        use std::os::unix::fs::PermissionsExt;

        let (dir, roots) = media_scratch("media-outside");
        let secret = dir.join("secret.png");

        std::os::unix::fs::symlink(&secret, dir.join("root/link.png")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("root/up")).unwrap();
        fs::set_permissions(&secret, fs::Permissions::from_mode(0o000)).unwrap();

        for reference in [
            "../secret.png",
            &secret.to_string_lossy(),
            "link.png",
            "up/secret.png",
            "sub/../../secret.png",
        ] {
            assert!(
                matches!(read_media(&roots, reference), MediaRead::Refused),
                "{reference}"
            );
            assert!(
                resolve_existing(reference, &roots)
                    .unwrap_err()
                    .ends_with("outside the shared folders"),
                "{reference} must be refused by the path check, before any open"
            );
        }

        fs::set_permissions(&secret, fs::Permissions::from_mode(0o644)).unwrap();
    }

    #[test]
    fn a_path_is_judged_on_its_text_before_anything_resolves_it() {
        let root = Path::new("/work/project");

        assert_eq!(
            lexically_inside(root, "out/a.png"),
            Some(PathBuf::from("/work/project/out/a.png"))
        );
        assert_eq!(
            lexically_inside(root, "./out/../a.png"),
            Some(PathBuf::from("/work/project/a.png"))
        );
        assert_eq!(
            lexically_inside(root, "/work/project/out/a.png"),
            Some(PathBuf::from("/work/project/out/a.png"))
        );

        for outside in [
            "../a.png",
            "out/../../a.png",
            "/net/host/a.png",
            "/Volumes/share/a.png",
            "/work/project/../other/a.png",
            "/work/projectile/a.png",
            "/etc/passwd",
        ] {
            assert_eq!(lexically_inside(root, outside), None, "{outside}");
        }
    }

    #[test]
    fn a_network_path_is_refused_without_resolution_being_attempted() {
        let (_dir, roots) = media_scratch("media-network");

        // None of these exist, so a refusal by the file system and one by the text could not be told apart by the
        // result alone; the text check is pinned by `a_path_is_judged_on_its_text_before_anything_resolves_it`.
        for reference in [
            r"\\host\share\a.png",
            "/net/host/a.png",
            "//host/share/a.png",
        ] {
            assert!(
                matches!(read_media(&roots, reference), MediaRead::Refused),
                "{reference}"
            );
        }
    }

    #[test]
    fn a_url_a_missing_file_a_folder_and_a_page_are_refused() {
        let (dir, roots) = media_scratch("media-refused");

        fs::write(dir.join("root/page.html"), "<script>1</script>").unwrap();
        fs::write(dir.join("root/fake.png"), "<script>1</script>").unwrap();
        fs::write(dir.join("root/page.png.html"), PNG_HEAD).unwrap();

        for reference in [
            "https://example.com/chart.png",
            "file:///etc/passwd",
            "missing.png",
            "sub",
            "page.html",
            "fake.png",
            "page.png.html",
            "",
        ] {
            assert!(
                matches!(read_media(&roots, reference), MediaRead::Refused),
                "{reference}"
            );
        }
    }

    #[test]
    fn a_file_over_the_upload_cap_is_named_with_its_size_and_not_read() {
        let (dir, roots) = media_scratch("media-large");
        let big = fs::File::create(dir.join("root/big.png")).unwrap();
        let size = media::MAX_UPLOAD_BYTES + 5;

        (&big).write_all(&PNG_HEAD).unwrap();
        big.set_len(size).unwrap();

        match read_media(&roots, "big.png") {
            MediaRead::TooLarge {
                name, size: seen, ..
            } => {
                assert_eq!(name, "big.png");
                assert_eq!(seen, size);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn an_image_over_the_inline_cap_is_offered_as_a_file() {
        let (dir, roots) = media_scratch("media-inline");
        let large = fs::File::create(dir.join("root/large.png")).unwrap();

        (&large).write_all(&PNG_HEAD).unwrap();
        large.set_len(media::MAX_INLINE_IMAGE_BYTES + 1).unwrap();

        match read_media(&roots, "large.png") {
            MediaRead::Read(file) => {
                assert_eq!(file.kind, Kind::File);
                assert_eq!(file.mime, "image/png");
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn the_size_comes_from_the_bytes_read() {
        let (dir, roots) = media_scratch("media-size");
        let exact = fs::File::create(dir.join("root/exact.png")).unwrap();

        (&exact).write_all(&PNG_HEAD).unwrap();
        exact.set_len(media::MAX_INLINE_IMAGE_BYTES).unwrap();

        match read_media(&roots, "exact.png") {
            MediaRead::Read(file) => {
                assert_eq!(file.kind, Kind::Image);
                assert_eq!(file.bytes.len() as u64, media::MAX_INLINE_IMAGE_BYTES);
            }
            other => panic!("{other:?}"),
        }
    }

    #[test]
    fn only_a_name_surrogate_reparse_tag_is_a_link() {
        assert!(is_name_surrogate(0xA000_000C), "symlink");
        assert!(is_name_surrogate(0xA000_0003), "mount point (junction)");
        assert!(!is_name_surrogate(0x9000_001A), "cloud files placeholder");
        assert!(!is_name_surrogate(0x8000_0013), "deduplicated file");
        assert!(!is_name_surrogate(0));
    }

    #[test]
    fn a_folder_pages_in_name_order_without_repeating_or_skipping() {
        let dir = scratch("pages");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        for name in ["d", "b", "c", "e"] {
            fs::write(dir.join("root").join(name), name).unwrap();
        }

        let names = |page: &Value| -> Vec<String> {
            page["entries"]
                .as_array()
                .unwrap()
                .iter()
                .map(|entry| entry["name"].as_str().unwrap().to_owned())
                .collect()
        };
        let first = list_page(&roots, &roots[0], None, 3).unwrap();
        let second = list_page(&roots, &roots[0], first["next"].as_str(), 3).unwrap();
        let past_the_end = list_page(&roots, &roots[0], Some("sub"), 3).unwrap();

        assert_eq!(names(&first), ["a.txt", "b", "c"]);
        assert_eq!(first["next"], "c");
        assert_eq!(names(&second), ["d", "e", "sub"]);
        // Exactly the last page: nothing follows it, so there is no cursor.
        assert!(second["next"].is_null());
        assert!(names(&past_the_end).is_empty());
        assert!(list_page(&roots, &roots[0].join("a.txt"), None, 3).is_err());
    }

    #[test]
    fn a_large_folder_pages_completely_in_name_order() {
        let dir = scratch("many");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);

        for index in 0..2500 {
            fs::write(dir.join(format!("root/f{index:05}")), "x").unwrap();
        }

        let mut seen = Vec::new();
        let mut after: Option<String> = None;
        let mut pages = 0;

        loop {
            let page = list_page(&roots, &roots[0], after.as_deref(), 1000).unwrap();

            pages += 1;
            seen.extend(page["entries"].as_array().unwrap().iter().map(|entry| {
                (
                    entry["name"].as_str().unwrap().to_owned(),
                    entry["size"].as_u64().unwrap(),
                )
            }));

            match page["next"].as_str() {
                Some(next) => after = Some(next.to_owned()),
                None => break,
            }
        }

        // The file and folder `scratch` made, and the 2,500 more, once each and in order.
        assert_eq!(pages, 3);
        assert_eq!(seen.len(), 2502);
        assert!(seen.windows(2).all(|pair| pair[0].0 < pair[1].0));
        assert!(seen
            .iter()
            .any(|(name, size)| name == "f02499" && *size == 1));
    }

    #[test]
    fn a_folder_larger_than_the_scan_cap_says_so() {
        let dir = scratch("scan");
        let roots = canonical_roots(&[dir.join("root").to_string_lossy().into_owned()]);
        let page = confined::page(&roots, &roots[0], None, 10, 1).unwrap();

        assert!(page.cut);
        assert_eq!(page.entries.len(), 1);
    }
}
