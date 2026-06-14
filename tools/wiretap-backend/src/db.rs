//! Connection-pool registry: one deadpool pool per capture database, created
//! lazily. Database names are strictly validated before they reach a DSN or
//! SQL, and existence is checked against pg_database.

use std::collections::HashMap;
use std::sync::Arc;

use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod};
use tokio::sync::Mutex;
use tokio_postgres::NoTls;

use crate::config::Config;
use crate::schema;

pub fn valid_db_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name.chars().next().is_some_and(|c| c.is_ascii_lowercase())
        && name.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
}

#[derive(Clone)]
pub struct Databases {
    config: Arc<Config>,
    pools: Arc<Mutex<HashMap<String, Pool>>>,
    /// Serialises CREATE DATABASE races between concurrent first connections.
    create_lock: Arc<Mutex<()>>,
}

impl Databases {
    pub fn new(config: Arc<Config>) -> Self {
        Self {
            config,
            pools: Arc::new(Mutex::new(HashMap::new())),
            create_lock: Arc::new(Mutex::new(())),
        }
    }

    pub fn default_database(&self) -> &str {
        &self.config.default_database
    }

    fn build_pool(&self, database: &str) -> Result<Pool, String> {
        let pg_config: tokio_postgres::Config = self
            .config
            .pg_dsn(database)
            .parse()
            .map_err(|e| format!("bad DSN: {e}"))?;
        let mgr = Manager::from_config(
            pg_config,
            NoTls,
            ManagerConfig { recycling_method: RecyclingMethod::Fast },
        );
        Pool::builder(mgr)
            .max_size(8)
            .build()
            .map_err(|e| format!("pool build failed: {e}"))
    }

    /// One-off (non-pooled) connection, used for CREATE DATABASE and bootstrap.
    pub async fn connect_raw(&self, database: &str) -> Result<tokio_postgres::Client, String> {
        let (client, connection) = tokio_postgres::connect(&self.config.pg_dsn(database), NoTls)
            .await
            .map_err(|e| format!("connect to '{database}' failed: {e}"))?;
        tokio::spawn(async move {
            if let Err(e) = connection.await {
                tracing::debug!("postgres connection closed: {e}");
            }
        });
        Ok(client)
    }

    pub async fn database_exists(&self, name: &str) -> Result<bool, String> {
        let client = self.connect_raw("postgres").await?;
        let row = client
            .query_one("SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)", &[&name])
            .await
            .map_err(|e| format!("pg_database lookup failed: {e}"))?;
        Ok(row.get(0))
    }

    /// Create a capture database (idempotent) and apply the schema.
    pub async fn create_database(&self, name: &str) -> Result<(), String> {
        if !valid_db_name(name) {
            return Err(format!("invalid database name '{name}'"));
        }
        let _guard = self.create_lock.lock().await;
        if !self.database_exists(name).await? {
            let client = self.connect_raw("postgres").await?;
            // CREATE DATABASE is non-transactional; name is validated above.
            client
                .batch_execute(&format!("CREATE DATABASE {name}"))
                .await
                .map_err(|e| format!("CREATE DATABASE {name} failed: {e}"))?;
            tracing::info!("created database '{name}'");
        }
        let client = self.connect_raw(name).await?;
        schema::apply_capture_schema(&client).await?;
        Ok(())
    }

    /// Drop a capture database (admin). Refuses the default database (it holds
    /// the API-key store). Removes the pool first, then DROP ... WITH (FORCE)
    /// to terminate any lingering query connections. Callers must ensure it is
    /// not actively being ingested.
    pub async fn delete_database(&self, name: &str) -> Result<(), String> {
        if !valid_db_name(name) {
            return Err(format!("invalid database name '{name}'"));
        }
        if name == self.config.default_database {
            return Err("cannot delete the default database".into());
        }
        self.pools.lock().await.remove(name);
        if !self.database_exists(name).await? {
            return Ok(());
        }
        let client = self.connect_raw("postgres").await?;
        client
            .batch_execute(&format!("DROP DATABASE IF EXISTS {name} WITH (FORCE)"))
            .await
            .map_err(|e| format!("DROP DATABASE {name} failed: {e}"))?;
        tracing::info!("dropped database '{name}'");
        Ok(())
    }

    /// Pool for an existing capture database. Errors if it doesn't exist —
    /// callers wanting auto-create go through `ensure_database` first.
    pub async fn pool(&self, name: &str) -> Result<Pool, String> {
        if !valid_db_name(name) {
            return Err(format!("invalid database name '{name}'"));
        }
        {
            let pools = self.pools.lock().await;
            if let Some(pool) = pools.get(name) {
                return Ok(pool.clone());
            }
        }
        if !self.database_exists(name).await? {
            return Err(format!("database '{name}' does not exist"));
        }
        let pool = self.build_pool(name)?;
        self.pools.lock().await.insert(name.to_string(), pool.clone());
        Ok(pool)
    }

    /// Resolve a database for ingest/import: existing, or auto-created when
    /// the config allows. Returns the pool.
    pub async fn ensure_database(&self, name: &str, allow_create: bool) -> Result<Pool, String> {
        if !valid_db_name(name) {
            return Err(format!("invalid database name '{name}'"));
        }
        if !self.database_exists(name).await? {
            if !(allow_create && self.config.auto_create_databases) {
                return Err(format!("database '{name}' does not exist (auto-create disabled)"));
            }
            self.create_database(name).await?;
        }
        self.pool(name).await
    }
}

#[cfg(test)]
mod tests {
    use super::valid_db_name;

    #[test]
    fn db_name_validation() {
        assert!(valid_db_name("wiretap"));
        assert!(valid_db_name("vehicle_1"));
        assert!(!valid_db_name(""));
        assert!(!valid_db_name("1leading_digit"));
        assert!(!valid_db_name("Has-Caps"));
        assert!(!valid_db_name("name;drop table"));
        assert!(!valid_db_name(&"x".repeat(64)));
    }
}
