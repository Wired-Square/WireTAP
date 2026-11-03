use std::path::PathBuf;

/// `$TMPDIR/<name>-<pid>`, emptied first: a reused pid would otherwise reopen an earlier
/// run's databases, rows and all.
pub(crate) fn fresh_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}
