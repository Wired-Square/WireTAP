//! API key store. Keys live in `wiretap_meta.api_keys` in the default
//! database (sha256-hashed; the plaintext is shown once at creation).
//! A bootstrap admin key from the environment is always honoured so the
//! stack can never lock itself out.

use std::collections::HashMap;
use std::sync::Arc;

use chrono::{DateTime, Utc};
use rand::RngCore;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tokio::sync::RwLock;

use crate::db::Databases;

const META_SCHEMA: &str = r#"
CREATE SCHEMA IF NOT EXISTS wiretap_meta;
CREATE TABLE IF NOT EXISTS wiretap_meta.api_keys (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT        NOT NULL,
  key_hash      TEXT        NOT NULL UNIQUE,
  role          TEXT        NOT NULL CHECK (role IN ('read', 'ingest', 'admin')),
  database_pin  TEXT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz
);
"#;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Role {
    Read,
    Ingest,
    Admin,
}

impl Role {
    pub fn parse(s: &str) -> Option<Role> {
        match s {
            "read" => Some(Role::Read),
            "ingest" => Some(Role::Ingest),
            "admin" => Some(Role::Admin),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Role::Read => "read",
            Role::Ingest => "ingest",
            Role::Admin => "admin",
        }
    }

    /// admin ⊇ read; admin ⊇ ingest (an admin key can do anything).
    pub fn allows_read(self) -> bool {
        matches!(self, Role::Read | Role::Admin)
    }

    pub fn allows_ingest(self) -> bool {
        matches!(self, Role::Ingest | Role::Admin)
    }

    pub fn allows_admin(self) -> bool {
        matches!(self, Role::Admin)
    }
}

#[derive(Debug, Clone)]
pub struct KeyInfo {
    pub id: i64,
    pub name: String,
    pub role: Role,
    pub database_pin: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct KeySummary {
    pub id: i64,
    pub name: String,
    pub role: Role,
    pub database_pin: Option<String>,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub revoked: bool,
}

fn hash_key(key: &str) -> String {
    hex::encode(Sha256::digest(key.as_bytes()))
}

#[derive(Clone)]
pub struct KeyStore {
    dbs: Databases,
    bootstrap_hash: Option<String>,
    /// key_hash -> KeyInfo for active (non-revoked) keys.
    cache: Arc<RwLock<HashMap<String, KeyInfo>>>,
}

impl KeyStore {
    pub fn new(dbs: Databases, bootstrap_admin_key: Option<&str>) -> Self {
        Self {
            dbs,
            bootstrap_hash: bootstrap_admin_key.map(hash_key),
            cache: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    /// Create the meta schema and warm the cache. Call once at startup,
    /// after the default database exists.
    pub async fn bootstrap(&self) -> Result<(), String> {
        let client = self.dbs.connect_raw(self.dbs.default_database()).await?;
        client
            .batch_execute(META_SCHEMA)
            .await
            .map_err(|e| format!("meta schema failed: {e}"))?;
        self.reload().await
    }

    pub async fn reload(&self) -> Result<(), String> {
        let client = self.dbs.connect_raw(self.dbs.default_database()).await?;
        let rows = client
            .query(
                "SELECT id, name, key_hash, role, database_pin \
                 FROM wiretap_meta.api_keys WHERE revoked_at IS NULL",
                &[],
            )
            .await
            .map_err(|e| format!("key load failed: {e}"))?;
        let mut map = HashMap::new();
        for row in &rows {
            let role = Role::parse(row.get::<_, &str>("role")).unwrap_or(Role::Read);
            map.insert(
                row.get::<_, String>("key_hash"),
                KeyInfo {
                    id: row.get("id"),
                    name: row.get("name"),
                    role,
                    database_pin: row.get("database_pin"),
                },
            );
        }
        *self.cache.write().await = map;
        Ok(())
    }

    /// Validate a plaintext key. Comparison is hash-to-hash, so timing leaks
    /// nothing about the stored keys.
    pub async fn validate(&self, key: &str) -> Option<KeyInfo> {
        let h = hash_key(key);
        if self.bootstrap_hash.as_deref() == Some(h.as_str()) {
            return Some(KeyInfo {
                id: 0,
                name: "bootstrap-admin".into(),
                role: Role::Admin,
                database_pin: None,
            });
        }
        let info = self.cache.read().await.get(&h).cloned()?;
        self.touch_last_used(info.id);
        Some(info)
    }

    /// Fire-and-forget last_used update (best effort, never blocks auth).
    fn touch_last_used(&self, id: i64) {
        let dbs = self.dbs.clone();
        tokio::spawn(async move {
            if let Ok(client) = dbs.connect_raw(dbs.default_database()).await {
                let _ = client
                    .execute(
                        "UPDATE wiretap_meta.api_keys SET last_used_at = now() \
                         WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - INTERVAL '1 minute')",
                        &[&id],
                    )
                    .await;
            }
        });
    }

    /// Create a key; returns the plaintext (shown once, never stored).
    pub async fn create(
        &self,
        name: &str,
        role: Role,
        database_pin: Option<&str>,
    ) -> Result<(i64, String), String> {
        let mut raw = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut raw);
        let plaintext = format!("wt_{}", hex::encode(raw));
        let client = self.dbs.connect_raw(self.dbs.default_database()).await?;
        let row = client
            .query_one(
                "INSERT INTO wiretap_meta.api_keys (name, key_hash, role, database_pin) \
                 VALUES ($1, $2, $3, $4) RETURNING id",
                &[&name, &hash_key(&plaintext), &role.as_str(), &database_pin],
            )
            .await
            .map_err(|e| format!("key create failed: {e}"))?;
        self.reload().await?;
        Ok((row.get(0), plaintext))
    }

    pub async fn revoke(&self, id: i64) -> Result<bool, String> {
        let client = self.dbs.connect_raw(self.dbs.default_database()).await?;
        let n = client
            .execute(
                "UPDATE wiretap_meta.api_keys SET revoked_at = now() \
                 WHERE id = $1 AND revoked_at IS NULL",
                &[&id],
            )
            .await
            .map_err(|e| format!("key revoke failed: {e}"))?;
        self.reload().await?;
        Ok(n > 0)
    }

    /// Reinstate a revoked key.
    pub async fn unrevoke(&self, id: i64) -> Result<bool, String> {
        let client = self.dbs.connect_raw(self.dbs.default_database()).await?;
        let n = client
            .execute(
                "UPDATE wiretap_meta.api_keys SET revoked_at = NULL \
                 WHERE id = $1 AND revoked_at IS NOT NULL",
                &[&id],
            )
            .await
            .map_err(|e| format!("key restore failed: {e}"))?;
        self.reload().await?;
        Ok(n > 0)
    }

    /// Permanently delete a key row.
    pub async fn delete(&self, id: i64) -> Result<bool, String> {
        let client = self.dbs.connect_raw(self.dbs.default_database()).await?;
        let n = client
            .execute("DELETE FROM wiretap_meta.api_keys WHERE id = $1", &[&id])
            .await
            .map_err(|e| format!("key delete failed: {e}"))?;
        self.reload().await?;
        Ok(n > 0)
    }

    pub async fn list(&self) -> Result<Vec<KeySummary>, String> {
        let client = self.dbs.connect_raw(self.dbs.default_database()).await?;
        let rows = client
            .query(
                "SELECT id, name, role, database_pin, created_at, last_used_at, revoked_at \
                 FROM wiretap_meta.api_keys ORDER BY id",
                &[],
            )
            .await
            .map_err(|e| format!("key list failed: {e}"))?;
        Ok(rows
            .iter()
            .map(|r| KeySummary {
                id: r.get("id"),
                name: r.get("name"),
                role: Role::parse(r.get::<_, &str>("role")).unwrap_or(Role::Read),
                database_pin: r.get("database_pin"),
                created_at: r.get("created_at"),
                last_used_at: r.get("last_used_at"),
                revoked: r.get::<_, Option<DateTime<Utc>>>("revoked_at").is_some(),
            })
            .collect())
    }
}
