//! A headless machine the person owns, paired as a device of its own (plans/coding-workbench.md 7.2).
//!
//! `neore-host pair` shows a short code on the machine; the signed-in owner approves it in the web app; the
//! machine's next poll receives its device id and secret, ONCE, straight from the backend (`pair`). The secret
//! is kept in the OS keychain where there is one, else in a 0600 file (`vault`), and the pairing says which
//! before the owner approves and again when it is stored. `neore-host run` then holds the pairing and decides
//! what may be called on this machine (`serve`).
//!
//! This is a different path from an SSH-reached server, whose secret stays on the desktop that holds it
//! (`ssh.rs`, `engine/hosts.rs`). Nothing here opens a listener: pairing is an outbound request, and the
//! foreground run reads signed calls from its own stdin.
//!
//! Seam for the service slice: `serve::Service` is what a launchd or systemd user service would run in place
//! of the stdin loop. The unit files, the install command and the outbound relay are not part of this slice.

pub mod cli;
pub mod http;
pub mod pair;
pub mod serve;
pub mod vault;
