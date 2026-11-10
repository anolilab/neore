//! A headless machine the person owns, paired as a device of its own.
//!
//! The pairing secret is kept in the OS keychain where there is one, else in a 0600 file (`vault`); the pairing
//! says which before the owner approves and again when it is stored. This is a different path from an SSH-reached
//! server, whose secret stays on the desktop that holds it (`ssh.rs`, `engine/hosts.rs`).

pub mod vault;
