//! WireTAP backend gateway: binary CAN ingest (TCP) + HTTP query API over
//! TimescaleDB. The only process that talks to Postgres — devices and the
//! desktop client authenticate with API keys.

mod config;
mod db;
mod http;
mod ingest;
mod keys;
mod running;
mod schema;
mod sql;
mod state;
mod types;

use std::sync::Arc;
use std::time::Duration;

use config::Config;
use db::Databases;
use ingest::{IngestServer, Sessions};
use keys::KeyStore;
use state::AppState;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "wiretap_backend=info".into()),
        )
        .init();

    if let Err(e) = run().await {
        tracing::error!("fatal: {e}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), String> {
    let config = Arc::new(Config::from_env()?);
    let dbs = Databases::new(config.clone());

    // Wait for Postgres (compose healthcheck usually beats us here, but a
    // bare `docker start` of this container alone must also work)
    let mut attempts = 0u32;
    loop {
        match dbs.connect_raw("postgres").await {
            Ok(_) => break,
            Err(e) if attempts < 60 => {
                attempts += 1;
                tracing::info!("waiting for postgres ({attempts}): {e}");
                tokio::time::sleep(Duration::from_secs(2)).await;
            }
            Err(e) => return Err(format!("postgres unreachable: {e}")),
        }
    }

    // Bootstrap: default capture database + schema, then the key store
    dbs.create_database(&config.default_database).await?;
    let keys = KeyStore::new(dbs.clone(), config.bootstrap_admin_key.as_deref());
    keys.bootstrap().await?;
    if config.bootstrap_admin_key.is_none() {
        tracing::warn!("WIRETAP_ADMIN_KEY is not set — admin access requires a seeded key");
    }

    let sessions = Sessions::default();

    let ingest = Arc::new(IngestServer {
        config: config.clone(),
        dbs: dbs.clone(),
        keys: keys.clone(),
        sessions: sessions.clone(),
    });
    tokio::spawn(async move {
        if let Err(e) = ingest.run().await {
            tracing::error!("ingest listener failed: {e}");
            std::process::exit(1);
        }
    });

    let app_state = Arc::new(AppState { dbs, keys, sessions });
    let listener = tokio::net::TcpListener::bind(&config.http_listen)
        .await
        .map_err(|e| format!("http bind {}: {e}", config.http_listen))?;
    tracing::info!("http listening on {}", config.http_listen);
    axum::serve(listener, http::router(app_state))
        .await
        .map_err(|e| format!("http server: {e}"))
}
