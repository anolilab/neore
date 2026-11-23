//! A scratch folder for one test, removed when it is dropped, so a run leaves nothing in the temp folder even when
//! the test fails. Behind `test-support` so the integration tests can use it; no shipped build enables that.

use std::ops::Deref;
use std::path::{Path, PathBuf};

/// `<temp>/neore-<name>-<pid>`, emptied and created by [`TestDir::new`] and removed with everything in it on drop.
#[derive(Debug)]
pub struct TestDir(PathBuf);

impl TestDir {
    pub fn new(name: &str) -> Self {
        let dir = Self::at(name);

        std::fs::create_dir_all(&dir.0).unwrap();
        dir
    }

    /// The same path, emptied but not created, for a test whose code under test makes the folder itself.
    pub fn at(name: &str) -> Self {
        let dir = Self(std::env::temp_dir().join(format!("neore-{name}-{}", std::process::id())));

        dir.remove();
        dir
    }

    /// A folder the code under test made for itself, removed on drop like the others.
    pub fn adopt(path: impl Into<PathBuf>) -> Self {
        Self(path.into())
    }

    /// The folder by its real path (macOS's temp folder is behind a link), still removed on drop.
    pub fn canonical(mut self) -> Self {
        self.0 = std::fs::canonicalize(&self.0).unwrap();
        self
    }

    pub fn path(&self) -> &Path {
        &self.0
    }

    /// Removes whatever is there: a test may have put a file or a link where the folder goes.
    fn remove(&self) {
        match std::fs::symlink_metadata(&self.0) {
            Err(_) => return,
            Ok(meta) if !meta.is_dir() => {
                let _ = std::fs::remove_file(&self.0);
                return;
            }
            Ok(_) => {}
        }

        if std::fs::remove_dir_all(&self.0).is_ok() {
            return;
        }

        // A test may leave a folder its owner cannot list or enter; give the owner the folders back and retry.
        #[cfg(unix)]
        restore_permissions(&self.0);
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[cfg(unix)]
fn restore_permissions(dir: &Path) {
    use std::os::unix::fs::PermissionsExt;

    if std::fs::symlink_metadata(dir).is_ok_and(|meta| meta.is_dir()) {
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));

        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            restore_permissions(&entry.path());
        }
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        self.remove();
    }
}

impl Deref for TestDir {
    type Target = Path;

    fn deref(&self) -> &Path {
        &self.0
    }
}

impl AsRef<Path> for TestDir {
    fn as_ref(&self) -> &Path {
        &self.0
    }
}
