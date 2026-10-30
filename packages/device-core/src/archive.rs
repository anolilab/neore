//! A shared folder as one tar stream, for downloading it from a server.
//!
//! The walk is the same confinement as `fs_list` and `fs_read`: the folder is opened through
//! `fs::open_folder`, and everything below it by `openat` with `O_NOFOLLOW` from the descriptor of its
//! parent, so a symlink swapped in while the archive is written is never followed. Symlinks are not archived at
//! all (neither the link nor what it points at), nor are devices, FIFOs and sockets: the archive of an untrusted
//! server must not be able to plant a link when someone unpacks it, and the server is not trusted either way.
//! A regular file with more than one hard link is left out too: its other names may be outside the shared folders
//! (`ln` makes one without any permission on the target's folder), and `O_NOFOLLOW` cannot tell.
//!
//! The tar is hand-written ustar (a PAX `path` record for names that do not fit), because a tar library opens
//! files by name and would undo the descriptor walk. Owners are written as 0, modes without setuid, setgid and the
//! sticky bit, and nothing else about the server's accounts.
//!
//! Unix only: Windows has no `openat`, and the handle-based confinement of `fs.rs` has no directory walk yet.

use serde::Serialize;

/// Entries (files and folders) one archive holds at most.
pub const MAX_ENTRIES: u64 = 200_000;
/// File bytes one archive holds at most. A ustar size field holds 8 GiB.
pub const MAX_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// What an archive holds, and what it left out.
#[derive(Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub bytes: u64,
    pub files: u64,
    pub folders: u64,
    /// Entries left out on purpose: symlinks, hard-linked files, devices, FIFOs and sockets.
    pub skipped: u64,
    /// Files and folders that should be in the archive and are not: they could not be read, or lie deeper than
    /// the walk goes.
    pub unreadable: u64,
}

#[cfg(not(unix))]
pub fn write_tar(
    _roots: &[std::path::PathBuf],
    _folder: &std::path::Path,
    _out: &mut dyn std::io::Write,
    _stop: &dyn Fn() -> bool,
) -> Result<Summary, String> {
    Err("downloading a folder from a Windows server is not supported yet".into())
}

#[cfg(unix)]
pub use unix::write_tar;

#[cfg(unix)]
mod unix {
    use std::ffi::{CStr, CString, OsStr};
    use std::fs::File;
    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};

    use super::{Summary, MAX_BYTES, MAX_ENTRIES};

    /// Folders below the shared one that are followed.
    const MAX_DEPTH: usize = 64;
    const BLOCK: usize = 512;
    const COPY_BYTES: usize = 64 * 1024;

    /// Writes the folder `folder` (canonical, inside one of `roots`) to `out` as a tar archive named after the
    /// folder. `stop` is asked between files and between blocks of one; when it answers `true` the archive ends in
    /// an error and is incomplete. Any error leaves a stream that is not a valid archive.
    pub fn write_tar(
        roots: &[PathBuf],
        folder: &Path,
        out: &mut dyn Write,
        stop: &dyn Fn() -> bool,
    ) -> Result<Summary, String> {
        let name = folder
            .file_name()
            .ok_or("the folder has no name")?
            .as_encoded_bytes()
            .to_vec();

        if name.contains(&b'\\') {
            return Err(
                "the folder's name has a backslash, which an archive cannot carry safely".into(),
            );
        }

        let root = crate::fs::open_folder(roots, folder).map_err(|error| error.to_string())?;
        let stat = stat_fd(&root).ok_or("the folder cannot be read")?;
        let mut walk = Walk {
            out,
            stop,
            summary: Summary::default(),
        };

        walk.entry(&name, Kind::Folder, 0, stat.perm, stat.mtime)?;
        walk.folder(root, &name, 1)?;
        // Two empty blocks end an archive.
        walk.write(&[0; 1024])?;

        Ok(walk.summary)
    }

    #[derive(Clone, Copy, PartialEq)]
    enum Kind {
        File,
        Folder,
    }

    struct Walk<'a> {
        out: &'a mut dyn Write,
        stop: &'a dyn Fn() -> bool,
        summary: Summary,
    }

    fn openat(dir: libc::c_int, name: &CStr, flags: libc::c_int) -> io::Result<OwnedFd> {
        // SAFETY: `name` is NUL-terminated and outlives the call; the descriptor is owned from here on.
        let fd = unsafe {
            libc::openat(
                dir,
                name.as_ptr(),
                flags | libc::O_NOFOLLOW | libc::O_CLOEXEC,
            )
        };

        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        // SAFETY: `fd` was just returned by `openat` and nothing else owns it.
        Ok(unsafe { OwnedFd::from_raw_fd(fd) })
    }

    /// The names in a folder, sorted, read through a duplicate of its descriptor. A folder with more than
    /// [`MAX_ENTRIES`] names is an error: the archive could not hold them, and they are not all read into memory
    /// first.
    fn names(dir: &OwnedFd) -> io::Result<Vec<Vec<u8>>> {
        // SAFETY: `dir` is open; the duplicate is handed to `fdopendir`, which owns it until `closedir`.
        let fd = unsafe { libc::dup(dir.as_raw_fd()) };

        if fd < 0 {
            return Err(io::Error::last_os_error());
        }

        // SAFETY: `fd` is a descriptor of a folder that nothing else owns.
        let stream = unsafe { libc::fdopendir(fd) };

        if stream.is_null() {
            let error = io::Error::last_os_error();

            // SAFETY: `fdopendir` failed, so `fd` is still ours to close.
            unsafe { libc::close(fd) };

            return Err(error);
        }

        let mut found = Vec::new();

        loop {
            // SAFETY: `errno` is the calling thread's own; `stream` is live until `closedir`, and the entry is only
            // read before the next call.
            let entry = unsafe {
                *crate::fs::errno() = 0;

                libc::readdir(stream)
            };

            if entry.is_null() {
                // The end of the folder leaves `errno` alone; a failed read sets it and the names so far are not all.
                let error = io::Error::last_os_error();

                // SAFETY: `stream` came from `fdopendir` and is closed exactly once.
                unsafe { libc::closedir(stream) };

                return match error.raw_os_error() {
                    Some(0) | None => {
                        found.sort();

                        Ok(found)
                    }
                    Some(_) => Err(error),
                };
            }

            // SAFETY: `d_name` is a NUL-terminated string inside the entry returned above.
            let name = unsafe { CStr::from_ptr((*entry).d_name.as_ptr()) }.to_bytes();

            if !matches!(name, b"." | b"..") {
                if found.len() as u64 >= MAX_ENTRIES {
                    // SAFETY: `stream` came from `fdopendir` and is closed exactly once.
                    unsafe { libc::closedir(stream) };

                    return Err(io::Error::other(format!(
                        "the folder has more than {MAX_ENTRIES} entries"
                    )));
                }

                found.push(name.to_vec());
            }
        }
    }

    /// What an entry is, read without following it (or from an open descriptor).
    struct Stat {
        /// The file type bits of the mode.
        kind: libc::mode_t,
        mtime: u64,
        /// Names the file has.
        links: u64,
        /// The permission bits of the mode: no setuid, setgid or sticky bit goes into an archive.
        perm: u32,
        size: u64,
    }

    // `mode_t` is `u16` on macOS and `u32` on Linux.
    #[allow(clippy::useless_conversion)]
    fn stat_of(stat: &libc::stat) -> Stat {
        Stat {
            kind: stat.st_mode & libc::S_IFMT,
            links: u64::from(stat.st_nlink),
            perm: u32::from(stat.st_mode & 0o777),
            // A ustar time field holds 11 octal digits (until the year 2242); a later time is written as that.
            mtime: (stat.st_mtime.max(0) as u64).min(0o77_777_777_777),
            size: stat.st_size.max(0) as u64,
        }
    }

    fn stat_at(dir: &OwnedFd, name: &CStr) -> Option<Stat> {
        // SAFETY: an all-zero `stat` is a valid out-parameter; `fstatat` fills it.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `dir` is open and `name` is NUL-terminated.
        let found = unsafe {
            libc::fstatat(
                dir.as_raw_fd(),
                name.as_ptr(),
                &mut stat,
                libc::AT_SYMLINK_NOFOLLOW,
            )
        } == 0;

        found.then(|| stat_of(&stat))
    }

    fn stat_fd(fd: &OwnedFd) -> Option<Stat> {
        // SAFETY: an all-zero `stat` is a valid out-parameter; `fstat` fills it.
        let mut stat: libc::stat = unsafe { std::mem::zeroed() };
        // SAFETY: `fd` is open.
        let found = unsafe { libc::fstat(fd.as_raw_fd(), &mut stat) } == 0;

        found.then(|| stat_of(&stat))
    }

    fn octal(field: &mut [u8], value: u64) {
        let digits = format!("{value:0width$o}", width = field.len() - 1);

        field[..digits.len()].copy_from_slice(digits.as_bytes());
    }

    /// One 512-byte header. `name` and `prefix` are already split to fit.
    fn header(
        name: &[u8],
        prefix: &[u8],
        flag: u8,
        size: u64,
        mode: u32,
        mtime: u64,
    ) -> [u8; BLOCK] {
        let mut block = [0u8; BLOCK];

        block[..name.len()].copy_from_slice(name);
        octal(&mut block[100..108], u64::from(mode & 0o777));
        octal(&mut block[108..116], 0);
        octal(&mut block[116..124], 0);
        octal(&mut block[124..136], size);
        octal(&mut block[136..148], mtime);
        block[156] = flag;
        block[257..263].copy_from_slice(b"ustar\0");
        block[263..265].copy_from_slice(b"00");
        block[345..345 + prefix.len()].copy_from_slice(prefix);

        // The checksum counts its own field as spaces.
        block[148..156].fill(b' ');

        let sum: u64 = block.iter().map(|byte| u64::from(*byte)).sum();

        octal(&mut block[148..155], sum);
        block[155] = b' ';

        block
    }

    /// Where a path splits into ustar's prefix (155 bytes) and name (100), at a `/`.
    fn split(path: &[u8]) -> Option<(&[u8], &[u8])> {
        if path.len() <= 100 {
            return Some((&[], path));
        }

        path.iter()
            .enumerate()
            .filter(|(index, byte)| {
                let name = path.len() - index - 1;

                **byte == b'/' && *index <= 155 && (1..=100).contains(&name)
            })
            .map(|(index, _)| index)
            .next()
            .map(|index| (&path[..index], &path[index + 1..]))
    }

    /// A PAX record `<length> path=<path>\n`, where the length counts itself.
    pub(super) fn pax_record(path: &[u8]) -> Vec<u8> {
        let body = b" path=".len() + path.len() + 1;
        let mut length = body + 1;

        while length.to_string().len() + body != length {
            length = length.to_string().len() + body;
        }

        let mut record = format!("{length} path=").into_bytes();

        record.extend_from_slice(path);
        record.push(b'\n');

        record
    }

    impl Walk<'_> {
        fn write(&mut self, bytes: &[u8]) -> Result<(), String> {
            self.out
                .write_all(bytes)
                .map_err(|error| format!("the archive could not be written: {error}"))
        }

        fn stopped(&self) -> Result<(), String> {
            if (self.stop)() {
                return Err("the download was stopped".into());
            }

            Ok(())
        }

        /// The header (and PAX header) of one entry. A folder's path ends in `/`.
        fn entry(
            &mut self,
            path: &[u8],
            kind: Kind,
            size: u64,
            mode: u32,
            mtime: u64,
        ) -> Result<(), String> {
            self.summary_count(kind, size)?;

            let mut path = path.to_vec();
            let flag = if kind == Kind::Folder {
                path.push(b'/');
                b'5'
            } else {
                b'0'
            };

            if let Some((prefix, name)) = split(&path) {
                return self.write(&header(name, prefix, flag, size, mode, mtime));
            }

            let record = pax_record(&path);

            self.write(&header(
                b"PaxHeaders/entry",
                &[],
                b'x',
                record.len() as u64,
                0o644,
                mtime,
            ))?;
            self.write(&record)?;
            self.pad(record.len() as u64)?;
            self.write(&header(&path[..100], &[], flag, size, mode, mtime))
        }

        fn summary_count(&mut self, kind: Kind, size: u64) -> Result<(), String> {
            if self.summary.files + self.summary.folders >= MAX_ENTRIES {
                return Err(format!("the folder has more than {MAX_ENTRIES} entries"));
            }

            if self.summary.bytes + size > MAX_BYTES {
                return Err("the folder is larger than 4 GiB".into());
            }

            match kind {
                Kind::File => self.summary.files += 1,
                Kind::Folder => self.summary.folders += 1,
            }

            self.summary.bytes += size;

            Ok(())
        }

        fn pad(&mut self, length: u64) -> Result<(), String> {
            let rest = (length % BLOCK as u64) as usize;

            if rest == 0 {
                return Ok(());
            }

            self.write(&[0; BLOCK][..BLOCK - rest])
        }

        /// Archives everything below the open folder `dir`, whose path in the archive is `base`.
        fn folder(&mut self, dir: OwnedFd, base: &[u8], depth: usize) -> Result<(), String> {
            let names = names(&dir).map_err(|error| error.to_string())?;

            for name in names {
                self.stopped()?;

                // A backslash separates path parts where the archive may be unpacked (Windows), so `..\..\x` would
                // climb out of the folder there: such a name is left out, like a link.
                if name.contains(&b'\\') {
                    self.summary.skipped += 1;

                    continue;
                }

                // A name from `readdir` holds no NUL.
                let Ok(c_name) = CString::new(name.as_slice()) else {
                    self.summary.skipped += 1;

                    continue;
                };
                let mut path = base.to_vec();

                path.push(b'/');
                path.extend_from_slice(&name);

                let Some(stat) = stat_at(&dir, &c_name) else {
                    self.summary.unreadable += 1;

                    continue;
                };

                match stat.kind {
                    libc::S_IFDIR if depth < MAX_DEPTH => {
                        // `O_DIRECTORY` and `O_NOFOLLOW`: a link swapped in since the stat fails here.
                        let Ok(child) =
                            openat(dir.as_raw_fd(), &c_name, libc::O_RDONLY | libc::O_DIRECTORY)
                        else {
                            self.summary.unreadable += 1;

                            continue;
                        };

                        self.entry(&path, Kind::Folder, 0, stat.perm, stat.mtime)?;
                        self.folder(child, &path, depth + 1)?;
                    }
                    libc::S_IFREG => self.file(&dir, &c_name, &path)?,
                    libc::S_IFDIR => self.summary.unreadable += 1,
                    _ => self.summary.skipped += 1,
                }
            }

            Ok(())
        }

        fn file(&mut self, dir: &OwnedFd, name: &CStr, path: &[u8]) -> Result<(), String> {
            // Non-blocking, so a FIFO swapped in for the file cannot hang the open.
            let opened = openat(dir.as_raw_fd(), name, libc::O_RDONLY | libc::O_NONBLOCK);
            let Some((fd, stat)) = opened
                .ok()
                .and_then(|fd| stat_fd(&fd).map(|stat| (fd, stat)))
            else {
                self.summary.unreadable += 1;

                return Ok(());
            };

            if stat.kind != libc::S_IFREG || stat.links != 1 {
                self.summary.skipped += 1;

                return Ok(());
            }

            self.entry(path, Kind::File, stat.size, stat.perm, stat.mtime)?;

            // The header promised `size` bytes: a file that grew is cut, and one that shrank fails the archive, which
            // must not hold bytes the server never had.
            let mut file = File::from(fd);
            let mut buffer = vec![0u8; COPY_BYTES];
            let mut left = stat.size;

            while left > 0 {
                self.stopped()?;

                let want = left.min(buffer.len() as u64) as usize;
                let read = match file.read(&mut buffer[..want]) {
                    Ok(0) => {
                        return Err(format!(
                            "{}: the file changed while it was archived",
                            OsStr::from_bytes(path).display()
                        ));
                    }
                    Ok(read) => read,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(error) => {
                        return Err(format!("{}: {error}", OsStr::from_bytes(path).display()));
                    }
                };

                self.write(&buffer[..read])?;
                left -= read as u64;
            }

            self.pad(stat.size)
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::unix::pax_record;
    use super::*;
    use std::fs;
    use std::io::Write;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("neore-archive-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(dir.join("root/sub")).unwrap();
        fs::write(dir.join("root/a.txt"), "hello").unwrap();
        fs::write(dir.join("root/sub/b.txt"), "x".repeat(1000)).unwrap();
        fs::write(dir.join("secret.txt"), "nope").unwrap();
        dir
    }

    fn roots(dir: &Path) -> Vec<PathBuf> {
        crate::fs::canonical_roots(&[dir.join("root").to_string_lossy().into_owned()])
    }

    fn archive(roots: &[PathBuf], folder: &Path) -> Result<(Vec<u8>, Summary), String> {
        let mut bytes = Vec::new();
        let summary = write_tar(roots, folder, &mut bytes, &|| false)?;

        Ok((bytes, summary))
    }

    /// What the system `tar` reads: the names, and the archive unpacked into `into`.
    fn system_tar(bytes: &[u8], dir: &Path, into: &str) -> (Vec<String>, PathBuf) {
        let file = dir.join(format!("{into}.tar"));
        let out = dir.join(into);

        fs::write(&file, bytes).unwrap();
        fs::create_dir_all(&out).unwrap();

        let list = Command::new("tar").arg("-tf").arg(&file).output().unwrap();

        assert!(list.status.success(), "tar -tf: {list:?}");
        assert!(Command::new("tar")
            .arg("-xf")
            .arg(&file)
            .arg("-C")
            .arg(&out)
            .status()
            .unwrap()
            .success());

        let mut names: Vec<String> = String::from_utf8_lossy(&list.stdout)
            .lines()
            .map(str::to_owned)
            .collect();

        names.sort();

        (names, out)
    }

    #[test]
    fn a_folder_is_archived_under_its_own_name_and_unpacks() {
        let dir = scratch("basic");
        let roots = roots(&dir);
        let (bytes, summary) = archive(&roots, &roots[0]).unwrap();
        let (names, out) = system_tar(&bytes, &dir, "basic");

        assert_eq!(bytes.len() % 512, 0);
        assert_eq!(
            summary,
            Summary {
                bytes: 1005,
                files: 2,
                folders: 2,
                skipped: 0,
                unreadable: 0
            }
        );
        assert_eq!(
            names,
            ["root/", "root/a.txt", "root/sub/", "root/sub/b.txt"]
        );
        assert_eq!(fs::read_to_string(out.join("root/a.txt")).unwrap(), "hello");
        assert_eq!(
            fs::read_to_string(out.join("root/sub/b.txt")).unwrap(),
            "x".repeat(1000)
        );
    }

    #[test]
    fn links_hard_links_and_special_files_are_left_out_and_never_followed() {
        let dir = scratch("links");
        let outside = dir.join("outside");

        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("inner.txt"), "outside-content").unwrap();
        std::os::unix::fs::symlink(dir.join("secret.txt"), dir.join("root/link.txt")).unwrap();
        std::os::unix::fs::symlink(&outside, dir.join("root/up")).unwrap();
        std::os::unix::fs::symlink("a.txt", dir.join("root/inside-link")).unwrap();
        fs::hard_link(dir.join("secret.txt"), dir.join("root/hard.txt")).unwrap();
        assert!(Command::new("mkfifo")
            .arg(dir.join("root/fifo"))
            .status()
            .unwrap()
            .success());

        let roots = roots(&dir);
        let (bytes, summary) = archive(&roots, &roots[0]).unwrap();
        let (names, _) = system_tar(&bytes, &dir, "links");
        let text = String::from_utf8_lossy(&bytes);

        assert_eq!(
            names,
            ["root/", "root/a.txt", "root/sub/", "root/sub/b.txt"]
        );
        assert_eq!(summary.skipped, 5);
        assert!(!text.contains("nope") && !text.contains("outside-content"));
    }

    #[test]
    fn a_name_with_a_backslash_is_left_out_so_no_unpacker_reads_it_as_a_path() {
        let dir = scratch("backslash");

        fs::write(dir.join("root").join("..\\..\\outside"), "x").unwrap();

        let roots = roots(&dir);
        let (bytes, summary) = archive(&roots, &roots[0]).unwrap();
        let (names, _) = system_tar(&bytes, &dir, "backslash");

        assert_eq!(
            names,
            ["root/", "root/a.txt", "root/sub/", "root/sub/b.txt"]
        );
        assert_eq!(summary.skipped, 1);
        assert!(!String::from_utf8_lossy(&bytes).contains("outside"));
    }

    #[test]
    fn a_time_too_late_for_the_header_is_clamped_not_a_panic() {
        let dir = scratch("late");
        let file = dir.join("root/late.txt");

        fs::create_dir_all(dir.join("root")).unwrap();
        fs::write(&file, "x").unwrap();
        // Year 2300, which needs twelve octal digits.
        fs::File::options()
            .write(true)
            .open(&file)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(10_413_792_000))
            .unwrap();

        let roots = roots(&dir);
        let (bytes, summary) = archive(&roots, &roots[0]).unwrap();

        assert!(summary.files >= 1);
        assert_eq!(bytes.len() % 512, 0);
    }

    #[test]
    fn what_could_not_be_read_is_counted_apart_from_what_is_left_out_on_purpose() {
        let dir = scratch("unreadable");

        fs::create_dir_all(dir.join("root")).unwrap();
        // Deeper than the walk goes.
        let mut deep = dir.join("root");

        for _ in 0..70 {
            deep.push("d");
        }

        fs::create_dir_all(&deep).unwrap();
        std::os::unix::fs::symlink("root", dir.join("root/link")).unwrap();

        let roots = roots(&dir);
        let (_, summary) = archive(&roots, &roots[0]).unwrap();

        assert_eq!(summary.skipped, 1);
        assert_eq!(summary.unreadable, 1);
    }

    #[test]
    fn long_paths_split_into_a_prefix_or_get_a_pax_record() {
        let dir = scratch("long");
        let deep = dir.join("root/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
        let split_name = "f".repeat(60);
        let long_name = "n".repeat(200);

        fs::create_dir_all(&deep).unwrap();
        fs::write(deep.join(&split_name), "split").unwrap();
        fs::write(deep.join(&long_name), "pax").unwrap();

        let roots = roots(&dir);
        let (bytes, _) = archive(&roots, &roots[0]).unwrap();
        let (names, out) = system_tar(&bytes, &dir, "long");
        let folder = deep.file_name().unwrap().to_string_lossy().into_owned();

        assert!(names.contains(&format!("root/{folder}/{split_name}")));
        assert!(names.contains(&format!("root/{folder}/{long_name}")));
        assert_eq!(
            fs::read_to_string(out.join(format!("root/{folder}/{long_name}"))).unwrap(),
            "pax"
        );
    }

    #[test]
    fn a_pax_record_counts_its_own_length() {
        for path in [&b"x"[..], &[b'y'; 85], &[b'z'; 86], &[b'w'; 997]] {
            let record = pax_record(path);
            let length: usize = String::from_utf8_lossy(&record)
                .split(' ')
                .next()
                .unwrap()
                .parse()
                .unwrap();

            assert_eq!(length, record.len());
        }
    }

    #[test]
    fn a_folder_swapped_for_a_link_after_planning_is_refused() {
        let dir = scratch("swap");
        let roots = roots(&dir);
        let planned = crate::fs::resolve_existing("sub", &roots).unwrap();

        fs::remove_dir_all(dir.join("root/sub")).unwrap();
        std::os::unix::fs::symlink(&dir, dir.join("root/sub")).unwrap();

        assert!(archive(&roots, &planned).is_err());
        assert!(archive(&roots, &dir).is_err(), "outside the shared folders");
    }

    #[test]
    fn stopping_ends_the_archive_in_an_error() {
        let dir = scratch("stop");
        let roots = roots(&dir);

        assert_eq!(
            write_tar(&roots, &roots[0], &mut Vec::new(), &|| true).unwrap_err(),
            "the download was stopped"
        );
    }

    #[test]
    fn an_unwritable_output_is_an_error_not_a_panic() {
        struct Full;

        impl Write for Full {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::BrokenPipe.into())
            }

            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }

        let dir = scratch("full");
        let roots = roots(&dir);

        assert!(write_tar(&roots, &roots[0], &mut Full, &|| false).is_err());
    }
}
