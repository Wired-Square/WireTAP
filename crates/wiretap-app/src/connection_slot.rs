//! A SQLite connection opened once at boot and lent to one caller at a time.

use rusqlite::Connection;
use std::path::Path;
use std::sync::Mutex;

pub struct ConnectionSlot(Mutex<Option<Connection>>);

impl ConnectionSlot {
    pub const fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Open the database at `path`, creating its directory, and prepare it with `init`.
    pub fn open(
        &self,
        path: &Path,
        what: &str,
        init: impl FnOnce(&mut Connection) -> Result<(), String>,
    ) -> Result<(), String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("Failed to create data dir: {e}"))?;
        }
        let mut conn = Connection::open(path).map_err(|e| format!("Failed to open {what}: {e}"))?;
        init(&mut conn)?;
        *self.lock()? = Some(conn);
        Ok(())
    }

    pub fn with<T>(&self, f: impl FnOnce(&mut Connection) -> Result<T, String>) -> Result<T, String> {
        #[cfg(test)]
        if self.lent_to_this_thread() {
            return THREAD_CONNECTIONS.with_borrow_mut(|lent| f(lent.get_mut(&self.key()).expect("lent connection")));
        }
        f(self.lock()?.as_mut().ok_or("Database not initialised")?)
    }

    fn lock(&self) -> Result<std::sync::MutexGuard<'_, Option<Connection>>, String> {
        self.0.lock().map_err(|_| "Database mutex poisoned".to_string())
    }
}

#[cfg(test)]
thread_local! {
    static THREAD_CONNECTIONS: std::cell::RefCell<std::collections::HashMap<usize, Connection>> =
        std::cell::RefCell::default();
}

/// While held, `with` on this thread uses this connection instead of the shared one.
#[cfg(test)]
#[must_use]
pub struct ThreadConnection(usize);

#[cfg(test)]
impl Drop for ThreadConnection {
    fn drop(&mut self) {
        THREAD_CONNECTIONS.with_borrow_mut(|lent| lent.remove(&self.0));
    }
}

#[cfg(test)]
impl ConnectionSlot {
    fn key(&self) -> usize {
        self as *const Self as usize
    }

    fn lent_to_this_thread(&self) -> bool {
        THREAD_CONNECTIONS.with_borrow(|lent| lent.contains_key(&self.key()))
    }

    pub fn install_once(&self, make: impl FnOnce() -> Connection) {
        self.0.lock().unwrap().get_or_insert_with(make);
    }

    pub fn lend_to_this_thread(&self, conn: Connection) -> ThreadConnection {
        THREAD_CONNECTIONS.with_borrow_mut(|lent| lent.insert(self.key(), conn));
        ThreadConnection(self.key())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user_version(slot: &ConnectionSlot) -> Result<i64, String> {
        slot.with(|conn| conn.query_row("PRAGMA user_version", [], |r| r.get(0)).map_err(|e| e.to_string()))
    }

    #[test]
    fn a_connection_lent_to_a_thread_is_seen_only_there_and_only_while_held() {
        static SLOT: ConnectionSlot = ConnectionSlot::new();
        assert_eq!(user_version(&SLOT), Err("Database not initialised".to_string()));

        let lent = Connection::open_in_memory().unwrap();
        lent.execute_batch("PRAGMA user_version = 7").unwrap();
        let guard = SLOT.lend_to_this_thread(lent);
        assert_eq!(user_version(&SLOT), Ok(7));
        assert!(std::thread::spawn(|| user_version(&SLOT)).join().unwrap().is_err());

        drop(guard);
        assert!(user_version(&SLOT).is_err());
    }

    #[test]
    fn open_creates_the_directory_and_prepares_the_connection() {
        let dir = std::env::temp_dir().join(format!("wiretap-connection-slot-{}", std::process::id()));
        let slot = ConnectionSlot::new();
        slot.open(&dir.join("nested/test.db"), "test database", |conn| {
            conn.execute_batch("PRAGMA user_version = 3").map_err(|e| e.to_string())
        })
        .unwrap();
        assert_eq!(user_version(&slot), Ok(3));
        drop(slot);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
