use std::path::Path;
use std::sync::Mutex;

/// Global log file handle. When `Some`, `tlog!` writes to both stderr and this file.
pub(crate) static LOG_FILE: Mutex<Option<std::fs::File>> = Mutex::new(None);

/// Initialise file logging to the given reports directory.
/// Creates a timestamped log file and a `CANdor.log` symlink (Unix only).
pub(crate) fn init_file_logging(reports_dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(reports_dir)
        .map_err(|e| format!("Failed to create reports dir: {}", e))?;

    let filename = chrono::Local::now()
        .format("%Y%m%d-%H%M%S-CANdor.log")
        .to_string();
    let log_path = reports_dir.join(&filename);

    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|e| format!("Failed to create log file: {}", e))?;

    // Update CANdor.log symlink (Unix only — Windows symlinks require elevated privileges)
    #[cfg(unix)]
    {
        let symlink_path = reports_dir.join("CANdor.log");
        // Remove existing symlink/file if present
        let _ = std::fs::remove_file(&symlink_path);
        if let Err(e) = std::os::unix::fs::symlink(&filename, &symlink_path) {
            eprintln!(
                "{} [logging] Failed to create CANdor.log symlink: {}",
                chrono::Local::now().format("%H:%M:%S%.3f"),
                e
            );
        }
    }

    if let Ok(mut guard) = LOG_FILE.lock() {
        *guard = Some(file);
    }

    // Use eprintln directly here since tlog! would try to lock LOG_FILE (which we just set)
    eprintln!(
        "{} [logging] File logging started: {}",
        chrono::Local::now().format("%H:%M:%S%.3f"),
        log_path.display()
    );

    Ok(())
}

/// Stop file logging and close the log file.
pub(crate) fn stop_file_logging() {
    if let Ok(mut guard) = LOG_FILE.lock() {
        if guard.is_some() {
            *guard = None;
            eprintln!(
                "{} [logging] File logging stopped",
                chrono::Local::now().format("%H:%M:%S%.3f")
            );
        }
    }
}

/// Timestamped logging macro.
/// Prepends `HH:MM:SS.mmm` local time to every message written to stderr.
/// Also writes to the log file when file logging is enabled.
macro_rules! tlog {
    ($($arg:tt)*) => {{
        use std::io::Write as _;
        let msg = format!("{} {}", chrono::Local::now().format("%H:%M:%S%.3f"), format_args!($($arg)*));
        eprintln!("{}", msg);
        if let Ok(mut guard) = $crate::logging::LOG_FILE.lock() {
            if let Some(ref mut f) = *guard {
                let _ = writeln!(f, "{}", msg);
            }
        }
    }};
}
