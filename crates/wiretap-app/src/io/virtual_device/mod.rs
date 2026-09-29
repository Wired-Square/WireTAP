// crates/wiretap-app/src/io/virtual_device/mod.rs
//
// Virtual device — synthetic traffic for testing without real hardware. The
// broker's virtual reader in `broker/spawner.rs` runs it.

pub(crate) mod traffic;

#[derive(Clone, Debug, PartialEq)]
pub enum VirtualTrafficType {
    /// Classic CAN — 8-byte frames, standard IDs
    Can,
    /// CAN FD — up to 64-byte frames
    CanFd,
    /// Modbus — synthetic register frames
    Modbus,
}
