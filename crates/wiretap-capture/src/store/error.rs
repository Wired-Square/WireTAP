/// What a capture store read or write fails with. Its text is SQLite's own
/// message; [`source`](std::error::Error::source) is the sqlx error.
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum CaptureError {
    #[error("{}", database_message(.0))]
    Database(#[source] wslib_db_sqlite::Error),
    #[error("{}", sqlite_message(.0))]
    Sqlite(#[source] sqlx::Error),
    /// Nothing of the step was applied.
    #[error("Migration {version} ({name}) failed: {}", sqlite_message(.source))]
    Migration {
        version: i64,
        name: &'static str,
        source: sqlx::Error,
    },
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Query cancelled")]
    Cancelled,
    #[error("Event not found")]
    EventNotFound,
    /// The file's `user_version` is newer than this build knows.
    #[error("The capture file is version {found}, newer than this build's {known}")]
    NewerFile { found: i64, known: i64 },
}

const SQLITE_INTERRUPT: &str = "9";

fn sqlite_message(e: &sqlx::Error) -> String {
    match e {
        sqlx::Error::Database(db) => db.message().to_owned(),
        _ => e.to_string(),
    }
}

fn database_message(e: &wslib_db_sqlite::Error) -> String {
    match e {
        wslib_db_sqlite::Error::Db(e) => sqlite_message(e),
        _ => e.to_string(),
    }
}

impl From<sqlx::Error> for CaptureError {
    fn from(e: sqlx::Error) -> Self {
        match &e {
            sqlx::Error::Database(db) if db.code().as_deref() == Some(SQLITE_INTERRUPT) => {
                Self::Cancelled
            }
            _ => Self::Sqlite(e),
        }
    }
}

impl From<wslib_db_sqlite::Error> for CaptureError {
    fn from(e: wslib_db_sqlite::Error) -> Self {
        match e {
            wslib_db_sqlite::Error::Db(e) => e.into(),
            e => Self::Database(e),
        }
    }
}

pub type Result<T> = std::result::Result<T, CaptureError>;

#[cfg(test)]
mod tests {
    use std::error::Error;

    use super::*;
    use crate::{Cancel, Sql};

    #[tokio::test]
    async fn the_text_is_sqlite_s_and_the_source_is_sqlx_s() {
        let store = crate::store::testing::store().await;
        let statement = Sql {
            sql: "SELECT * FROM no_such_table".into(),
            values: Vec::new(),
        };

        let err = store
            .read_rows(&statement, &Cancel::new(), |_| Ok(()))
            .await
            .unwrap_err();

        assert_eq!(err.to_string(), "no such table: no_such_table");
        assert!(err.source().unwrap().is::<sqlx::Error>());
    }

    #[test]
    fn user_visible_texts_are_capitalised() {
        assert_eq!(CaptureError::Cancelled.to_string(), "Query cancelled");
        assert_eq!(CaptureError::EventNotFound.to_string(), "Event not found");
    }
}
