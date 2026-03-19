// USB descriptor topology and endpoint discovery for gs_usb diagnostics.

use nusb::descriptors::TransferType;
use nusb::transfer::{ControlIn, ControlType, Direction, Recipient};
use nusb::{Device, DeviceInfo, Interface, MaybeFuture};
use wiretap_lib::io::gs_usb::{
    can_feature, GsDeviceBtConst, GsDeviceConfig, GsUsbBreq, GS_USB_PIDS, GS_USB_VID,
};

const CONTROL_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1000);

/// Discovered bulk endpoints for a gs_usb device.
pub struct BulkEndpoints {
    pub in_addr: u8,
    pub out_addr: u8,
    pub max_packet_size: usize,
}

/// Find a gs_usb device by serial (preferred) or bus:address.
pub fn find_device(bus: u8, address: u8, serial: Option<&str>) -> Result<DeviceInfo, String> {
    let mut devices = nusb::list_devices()
        .wait()
        .map_err(|e| format!("Failed to list USB devices: {}", e))?;

    devices
        .find(|dev| {
            if dev.vendor_id() != GS_USB_VID || !GS_USB_PIDS.contains(&dev.product_id()) {
                return false;
            }
            if let Some(target_serial) = serial {
                if let Some(dev_serial) = dev.serial_number() {
                    return dev_serial == target_serial;
                }
            }
            let dev_bus = dev.bus_id().parse::<u8>().unwrap_or(0);
            dev_bus == bus && dev.device_address() == address
        })
        .ok_or_else(|| {
            if let Some(s) = serial {
                format!("No gs_usb device found with serial '{}'", s)
            } else {
                format!("No gs_usb device found at {}:{}", bus, address)
            }
        })
}

/// Discover bulk IN and OUT endpoints from USB configuration descriptors.
/// Requires opening the device to read the active configuration.
pub fn discover_endpoints(device_info: &DeviceInfo) -> Result<BulkEndpoints, String> {
    let device = device_info
        .open()
        .wait()
        .map_err(|e| format!("Failed to open device for endpoint discovery: {}", e))?;

    discover_endpoints_from_device(&device)
}

/// Discover bulk IN and OUT endpoints from an already-opened device.
pub fn discover_endpoints_from_device(device: &Device) -> Result<BulkEndpoints, String> {
    let config = device
        .active_configuration()
        .map_err(|e| format!("Failed to get active configuration: {}", e))?;

    let mut in_addr: Option<u8> = None;
    let mut out_addr: Option<u8> = None;
    let mut max_pkt: usize = 64;

    for iface_group in config.interfaces() {
        for alt in iface_group.alt_settings() {
            for ep in alt.endpoints() {
                if ep.transfer_type() == TransferType::Bulk {
                    match ep.direction() {
                        Direction::In => {
                            in_addr = Some(ep.address());
                            max_pkt = ep.max_packet_size();
                        }
                        Direction::Out => {
                            out_addr = Some(ep.address());
                        }
                    }
                }
            }
        }
    }

    Ok(BulkEndpoints {
        in_addr: in_addr.ok_or("No bulk IN endpoint found in USB descriptors")?,
        out_addr: out_addr.ok_or("No bulk OUT endpoint found in USB descriptors")?,
        max_packet_size: max_pkt,
    })
}

/// Print the full USB descriptor topology for a device.
pub fn print_topology(device_info: &DeviceInfo) -> Result<(), String> {
    println!("USB Device Topology");
    println!("===================");
    println!(
        "  Bus: {}, Address: {}",
        device_info.bus_id(),
        device_info.device_address()
    );
    println!(
        "  VID:PID: {:04X}:{:04X}",
        device_info.vendor_id(),
        device_info.product_id()
    );
    println!(
        "  Product: {}",
        device_info.product_string().unwrap_or("(none)")
    );
    println!(
        "  Manufacturer: {}",
        device_info.manufacturer_string().unwrap_or("(none)")
    );
    println!(
        "  Serial: {}",
        device_info.serial_number().unwrap_or("(none)")
    );
    println!("  Speed: {:?}", device_info.speed());

    // Print interface summary from DeviceInfo
    for iface in device_info.interfaces() {
        println!("\n  Interface {} (from enumeration):", iface.interface_number());
        println!(
            "    Class: 0x{:02X}, Subclass: 0x{:02X}, Protocol: 0x{:02X}",
            iface.class(),
            iface.subclass(),
            iface.protocol()
        );
        if let Some(s) = iface.interface_string() {
            println!("    String: {}", s);
        }
    }

    // Open device to get full configuration descriptors
    let device = device_info
        .open()
        .wait()
        .map_err(|e| format!("Failed to open device: {}", e))?;

    match device.active_configuration() {
        Ok(config) => {
            println!(
                "\n  Active Configuration {} (from descriptors):",
                config.configuration_value()
            );
            println!("    Num interfaces: {}", config.num_interfaces());

            for iface_group in config.interfaces() {
                println!(
                    "\n    Interface {}:",
                    iface_group.interface_number()
                );
                for alt in iface_group.alt_settings() {
                    println!(
                        "      Alt Setting {}:",
                        alt.alternate_setting()
                    );
                    println!(
                        "        Class: 0x{:02X}, Subclass: 0x{:02X}, Protocol: 0x{:02X}",
                        alt.class(),
                        alt.subclass(),
                        alt.protocol()
                    );
                    println!("        Endpoints: {}", alt.num_endpoints());
                    for ep in alt.endpoints() {
                        println!(
                            "        Endpoint 0x{:02X}: {:?} {:?}, max_packet_size={}",
                            ep.address(),
                            ep.direction(),
                            ep.transfer_type(),
                            ep.max_packet_size()
                        );
                    }
                }
            }
        }
        Err(e) => {
            println!("\n  Failed to read configuration descriptors: {}", e);
        }
    }

    // Query gs_usb-specific info via control transfers
    let interface = device
        .claim_interface(0)
        .wait()
        .map_err(|e| format!("Failed to claim interface: {}", e))?;

    println!("\n  Device Config (GS_USB):");
    match query_device_config(&interface) {
        Ok(config) => {
            let icount = config.icount;
            let sw = config.sw_version;
            let hw = config.hw_version;
            println!("    Channels: {} (icount={})", icount + 1, icount);
            println!("    SW version: {}", sw);
            println!("    HW version: {}", hw);
        }
        Err(e) => println!("    Error: {}", e),
    }

    println!("\n  BT_CONST:");
    match query_bt_const(&interface) {
        Ok(bt) => {
            let feature = bt.feature;
            let fclk = bt.fclk_can;
            println!("    Feature flags: 0x{:08X}", feature);
            print_feature_flags(feature);
            println!(
                "    CAN clock: {} Hz ({:.1} MHz)",
                fclk, fclk as f64 / 1_000_000.0
            );
            let (t1min, t1max) = (bt.tseg1_min, bt.tseg1_max);
            let (t2min, t2max) = (bt.tseg2_min, bt.tseg2_max);
            let sjw = bt.sjw_max;
            let (bmin, bmax, binc) = (bt.brp_min, bt.brp_max, bt.brp_inc);
            println!(
                "    TSEG1: {}-{}, TSEG2: {}-{}, SJW max: {}",
                t1min, t1max, t2min, t2max, sjw
            );
            println!("    BRP: {}-{} (inc {})", bmin, bmax, binc);
        }
        Err(e) => println!("    Error: {}", e),
    }

    Ok(())
}

fn print_feature_flags(feature: u32) {
    let flags = [
        (can_feature::LISTEN_ONLY, "LISTEN_ONLY"),
        (can_feature::LOOP_BACK, "LOOP_BACK"),
        (can_feature::TRIPLE_SAMPLE, "TRIPLE_SAMPLE"),
        (can_feature::ONE_SHOT, "ONE_SHOT"),
        (can_feature::HW_TIMESTAMP, "HW_TIMESTAMP"),
        (can_feature::IDENTIFY, "IDENTIFY"),
        (can_feature::USER_ID, "USER_ID"),
        (
            can_feature::PAD_PKTS_TO_MAX_PKT_SIZE,
            "PAD_PKTS_TO_MAX_PKT_SIZE",
        ),
        (can_feature::FD, "FD"),
        (can_feature::REQ_USB_QUIRK_LPC546XX, "REQ_USB_QUIRK_LPC546XX"),
        (can_feature::BT_CONST_EXT, "BT_CONST_EXT"),
        (can_feature::TERMINATION, "TERMINATION"),
        (can_feature::BERR_REPORTING, "BERR_REPORTING"),
        (can_feature::GET_STATE, "GET_STATE"),
    ];
    let active: Vec<&str> = flags
        .iter()
        .filter(|(bit, _)| feature & bit != 0)
        .map(|(_, name)| *name)
        .collect();
    if active.is_empty() {
        println!("      (none)");
    } else {
        for name in &active {
            println!("      - {}", name);
        }
    }
}

fn query_device_config(interface: &Interface) -> Result<GsDeviceConfig, String> {
    let data = interface
        .control_in(
            ControlIn {
                control_type: ControlType::Vendor,
                recipient: Recipient::Interface,
                request: GsUsbBreq::DeviceConfig as u8,
                value: 1,
                index: 0,
                length: GsDeviceConfig::SIZE as u16,
            },
            CONTROL_TIMEOUT,
        )
        .wait()
        .map_err(|e| format!("DeviceConfig query failed: {:?}", e))?;

    GsDeviceConfig::from_bytes(&data).ok_or_else(|| {
        format!(
            "Incomplete DeviceConfig: got {} bytes, expected {}",
            data.len(),
            GsDeviceConfig::SIZE
        )
    })
}

fn query_bt_const(interface: &Interface) -> Result<GsDeviceBtConst, String> {
    let data = interface
        .control_in(
            ControlIn {
                control_type: ControlType::Vendor,
                recipient: Recipient::Interface,
                request: GsUsbBreq::BtConst as u8,
                value: 0,
                index: 0,
                length: GsDeviceBtConst::SIZE as u16,
            },
            CONTROL_TIMEOUT,
        )
        .wait()
        .map_err(|e| format!("BT_CONST query failed: {:?}", e))?;

    GsDeviceBtConst::from_bytes(&data).ok_or_else(|| {
        format!(
            "Incomplete BT_CONST: got {} bytes, expected {}",
            data.len(),
            GsDeviceBtConst::SIZE
        )
    })
}
