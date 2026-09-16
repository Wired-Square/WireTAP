// io/modbus_tcp/ranges.rs
//
// Poll groups from an address range instead of a catalogue.
//
// `build_polls_from_catalog` requires a TOML describing registers you already
// know about — which is exactly what you don't have when reverse-engineering a
// device. This module is its sibling for the discovery case: "sweep holding
// 0..511 every second" becomes the same `Vec<PollGroup>` a catalogue would have
// produced, so it flows through `create_multi_source_session`'s existing
// `modbus_polls` parameter with no new plumbing.

use serde::{Deserialize, Serialize};

use super::reader::{PollEmitMode, PollGroup, RegisterType};

fn default_device_address() -> u8 {
    1
}
fn default_interval_ms() -> u64 {
    1000
}
fn default_block_size() -> u16 {
    wiretap_catalog::modbus::MAX_REGISTERS_PER_READ
}
fn default_emit_mode() -> PollEmitMode {
    PollEmitMode::PerRegister
}
fn default_max_registers() -> u32 {
    4096
}
fn default_max_groups() -> u16 {
    64
}

/// One contiguous span of registers to poll.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModbusRange {
    pub register_type: RegisterType,
    /// Protocol-level start address (0-based).
    pub start: u16,
    /// Last address, inclusive.
    pub end: u16,
    /// Overrides the spec-level interval for this range.
    #[serde(default)]
    pub interval_ms: Option<u64>,
    /// Overrides the spec-level slave address for this range.
    #[serde(default)]
    pub device_address: Option<u8>,
}

/// A catalogue-free poll plan.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ModbusRangeSpec {
    pub ranges: Vec<ModbusRange>,
    #[serde(default = "default_device_address")]
    pub device_address: u8,
    #[serde(default = "default_interval_ms")]
    pub interval_ms: u64,
    /// Registers per request. Clamped to the protocol maximum for the type.
    #[serde(default = "default_block_size")]
    pub block_size: u16,
    /// Discovery defaults to one frame per register so per-register change
    /// analysis works; `Block` is available for the rare case where you want
    /// the raw response shape.
    #[serde(default = "default_emit_mode")]
    pub emit_mode: PollEmitMode,
    #[serde(default = "default_max_registers")]
    pub max_registers: u32,
    #[serde(default = "default_max_groups")]
    pub max_groups: u16,
}

impl Default for ModbusRangeSpec {
    fn default() -> Self {
        Self {
            ranges: Vec::new(),
            device_address: default_device_address(),
            interval_ms: default_interval_ms(),
            block_size: default_block_size(),
            emit_mode: default_emit_mode(),
            max_registers: default_max_registers(),
            max_groups: default_max_groups(),
        }
    }
}

/// Split each range into poll groups no larger than one Modbus request.
///
/// The `max_groups` cap is load-bearing, not cosmetic: every poll group becomes
/// its own task sharing one mutexed connection, so an unbounded sweep would
/// spawn hundreds of tasks contending on the same socket at the same interval —
/// the effective poll rate collapses and the device gets hammered.
pub fn build_polls_from_ranges(spec: &ModbusRangeSpec) -> Result<Vec<PollGroup>, String> {
    if spec.ranges.is_empty() {
        return Err("No register ranges given".to_string());
    }
    if spec.block_size == 0 {
        return Err("Block size must be at least 1".to_string());
    }
    // A zero interval is not a fast poll, it is a panic: `Cadence` hands the
    // interval to `tokio::time::interval`, which rejects a zero period — inside
    // a detached poll task, where it takes the source down with no diagnosis.
    // Checked here rather than at each caller because every author of a spec
    // (the picker, MCP) would otherwise have to know.
    if spec.interval_ms == 0 || spec.ranges.iter().any(|r| r.interval_ms == Some(0)) {
        return Err("Poll interval must be at least 1 ms".to_string());
    }

    let mut total_registers: u32 = 0;
    for r in &spec.ranges {
        if r.start > r.end {
            return Err(format!(
                "Range {}..{} is inverted — start must be <= end",
                r.start, r.end
            ));
        }
        total_registers += (r.end as u32) - (r.start as u32) + 1;
    }
    if total_registers > spec.max_registers {
        return Err(format!(
            "Range spec covers {} registers, over the {} limit — narrow the range or raise max_registers",
            total_registers, spec.max_registers
        ));
    }

    let mut polls = Vec::new();
    for r in &spec.ranges {
        let block = spec.block_size.min(r.register_type.catalog().max_per_read());
        let interval_ms = r.interval_ms.unwrap_or(spec.interval_ms);
        let device_address = r.device_address.unwrap_or(spec.device_address);

        let mut pos = r.start;
        loop {
            let remaining = r.end - pos + 1;
            let count = remaining.min(block);
            polls.push(PollGroup {
                register_type: r.register_type.clone(),
                start_register: pos,
                count,
                interval_ms,
                // Only consulted in `Block` mode; `PerRegister` derives an id per
                // register from `start_register`.
                frame_id: pos as u32,
                device_address,
                emit_mode: spec.emit_mode,
            });
            // `pos + count` can overflow u16 at the very top of the address space.
            match pos.checked_add(count) {
                Some(next) if next <= r.end => pos = next,
                _ => break,
            }
        }
    }

    if polls.len() > spec.max_groups as usize {
        return Err(format!(
            "Range spec needs {} poll groups, over the {} limit — each group is a task sharing one \
             connection, so raise block_size or narrow the range",
            polls.len(),
            spec.max_groups
        ));
    }

    Ok(polls)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(ranges: Vec<ModbusRange>) -> ModbusRangeSpec {
        ModbusRangeSpec {
            ranges,
            ..Default::default()
        }
    }

    fn range(rt: RegisterType, start: u16, end: u16) -> ModbusRange {
        ModbusRange {
            register_type: rt,
            start,
            end,
            interval_ms: None,
            device_address: None,
        }
    }

    #[test]
    fn splits_a_holding_range_into_125_register_blocks() {
        let polls = build_polls_from_ranges(&spec(vec![range(RegisterType::Holding, 0, 999)])).unwrap();
        assert_eq!(polls.len(), 8);
        assert_eq!(
            polls.iter().map(|p| (p.start_register, p.count)).collect::<Vec<_>>(),
            vec![
                (0, 125), (125, 125), (250, 125), (375, 125),
                (500, 125), (625, 125), (750, 125), (875, 125),
            ]
        );
    }

    #[test]
    fn a_partial_final_block_keeps_only_the_remaining_registers() {
        let polls = build_polls_from_ranges(&spec(vec![range(RegisterType::Holding, 0, 159)])).unwrap();
        assert_eq!(
            polls.iter().map(|p| (p.start_register, p.count)).collect::<Vec<_>>(),
            vec![(0, 125), (125, 35)]
        );
    }

    #[test]
    fn coils_use_the_2000_per_read_ceiling() {
        let mut s = spec(vec![range(RegisterType::Coil, 0, 2999)]);
        s.block_size = 2000;
        let polls = build_polls_from_ranges(&s).unwrap();
        assert_eq!(
            polls.iter().map(|p| (p.start_register, p.count)).collect::<Vec<_>>(),
            vec![(0, 2000), (2000, 1000)]
        );
    }

    #[test]
    fn an_oversized_block_clamps_to_the_protocol_maximum() {
        let mut s = spec(vec![range(RegisterType::Holding, 0, 499)]);
        s.block_size = 500;
        let polls = build_polls_from_ranges(&s).unwrap();
        assert!(polls.iter().all(|p| p.count <= 125));
        assert_eq!(polls.len(), 4);
    }

    #[test]
    fn discovery_defaults_to_one_frame_per_register() {
        let polls = build_polls_from_ranges(&spec(vec![range(RegisterType::Holding, 0, 9)])).unwrap();
        assert!(polls.iter().all(|p| p.emit_mode == PollEmitMode::PerRegister));
    }

    #[test]
    fn a_range_may_override_the_interval_and_slave() {
        let mut s = spec(vec![ModbusRange {
            register_type: RegisterType::Input,
            start: 0,
            end: 3,
            interval_ms: Some(250),
            device_address: Some(7),
        }]);
        s.interval_ms = 5000;
        s.device_address = 1;
        let polls = build_polls_from_ranges(&s).unwrap();
        assert_eq!(polls[0].interval_ms, 250);
        assert_eq!(polls[0].device_address, 7);
    }

    #[test]
    fn an_inverted_range_is_rejected() {
        let err = build_polls_from_ranges(&spec(vec![range(RegisterType::Holding, 100, 50)])).unwrap_err();
        assert!(err.contains("inverted"), "{err}");
    }

    #[test]
    fn a_range_over_the_register_cap_is_rejected() {
        let err = build_polls_from_ranges(&spec(vec![range(RegisterType::Holding, 0, 9999)])).unwrap_err();
        assert!(err.contains("max_registers"), "{err}");
    }

    #[test]
    fn too_many_groups_is_rejected_before_spawning_tasks() {
        let mut s = spec(vec![range(RegisterType::Holding, 0, 8191)]);
        s.max_registers = 65535;
        s.block_size = 1;
        let err = build_polls_from_ranges(&s).unwrap_err();
        assert!(err.contains("poll groups"), "{err}");
    }

    #[test]
    fn a_range_ending_at_the_top_of_the_address_space_terminates() {
        let mut s = spec(vec![range(RegisterType::Holding, 65400, 65535)]);
        s.max_registers = 65535;
        let polls = build_polls_from_ranges(&s).unwrap();
        assert_eq!(
            polls.iter().map(|p| (p.start_register, p.count)).collect::<Vec<_>>(),
            vec![(65400, 125), (65525, 11)]
        );
    }

    #[test]
    fn an_empty_spec_is_rejected() {
        assert!(build_polls_from_ranges(&spec(vec![])).is_err());
    }

    #[test]
    fn a_zero_interval_is_rejected_rather_than_panicking_a_poll_task() {
        // `tokio::time::interval` panics on a zero period, and it would do so
        // inside the detached poll task where nothing reports it.
        let mut s = spec(vec![range(RegisterType::Holding, 0, 9)]);
        s.interval_ms = 0;
        assert!(build_polls_from_ranges(&s).unwrap_err().contains("interval"));

        let mut s = spec(vec![range(RegisterType::Holding, 0, 9)]);
        s.ranges[0].interval_ms = Some(0);
        assert!(build_polls_from_ranges(&s).unwrap_err().contains("interval"));
    }
}
