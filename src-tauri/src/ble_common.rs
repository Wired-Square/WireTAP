// Shared BLE adapter management
//
// Provides a singleton BLE manager + adapter used by both the WiFi
// provisioning module (ble_provision) and the SMP firmware upgrade
// module (smp_upgrade).

use btleplug::api::Manager as _;
use btleplug::platform::{Adapter, Manager};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Mutex;
use uuid::Uuid;

// ============================================================================
// Shared adapter state
// ============================================================================

pub struct BleAdapterState {
    manager: Option<Manager>,
    pub adapter: Option<Adapter>,
}

pub static BLE_ADAPTER: Lazy<Arc<Mutex<BleAdapterState>>> = Lazy::new(|| {
    Arc::new(Mutex::new(BleAdapterState {
        manager: None,
        adapter: None,
    }))
});

/// Initialise the BLE manager and adapter if not already done.
pub async fn ensure_adapter() -> Result<(), String> {
    let mut state = BLE_ADAPTER.lock().await;
    if state.adapter.is_some() {
        return Ok(());
    }
    let manager =
        Manager::new().await.map_err(|e| format!("BLE manager init failed: {e}"))?;
    let adapters = manager
        .adapters()
        .await
        .map_err(|e| format!("Failed to list BLE adapters: {e}"))?;
    let adapter = adapters.into_iter().next().ok_or("No BLE adapter found")?;
    state.adapter = Some(adapter);
    state.manager = Some(manager);
    Ok(())
}

// ============================================================================
// Shared helpers
// ============================================================================

/// Build a 128-bit UUID from the same 5-field encoding used by Zephyr's
/// BT_UUID_128_ENCODE macro.
pub const fn uuid_from_fields(a: u32, b: u16, c: u16, d: u16, e: u64) -> Uuid {
    let hi: u64 = (a as u64) << 32 | (b as u64) << 16 | c as u64;
    let lo: u64 = (d as u64) << 48 | e;
    Uuid::from_u128(((hi as u128) << 64) | lo as u128)
}
