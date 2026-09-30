use nusb::descriptors::TransferType;
use nusb::transfer::{ControlIn, ControlType, Direction, Recipient};
use nusb::{DeviceInfo, Interface, MaybeFuture};
use wiretap_protocol::gs_usb::{can_feature, Breq, BtConst, DeviceConfig, DEVICES};

use crate::iface::GsUsbSelector;

const CONTROL_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(1000);

struct BulkEndpoints {
    in_addr: u8,
    out_addr: u8,
    max_packet_size: usize,
}

/// USB descriptors, the gs_usb device config and `BT_CONST`, and the bulk endpoints.
pub fn diag(selector: &GsUsbSelector) -> Result<(), String> {
    let device_info = find_device(selector)?;
    print_topology(&device_info)?;
    match discover_endpoints(&device_info) {
        Ok(eps) => {
            println!("\nDiscovered Bulk Endpoints:");
            println!("  IN:  0x{:02X}", eps.in_addr);
            println!("  OUT: 0x{:02X}", eps.out_addr);
            println!("  Max packet size: {}", eps.max_packet_size);
        }
        Err(e) => println!("\nEndpoint discovery failed: {}", e),
    }
    Ok(())
}

fn find_device(selector: &GsUsbSelector) -> Result<DeviceInfo, String> {
    nusb::list_devices()
        .wait()
        .map_err(|e| format!("Failed to list USB devices: {}", e))?
        .filter(|dev| DEVICES.contains(&(dev.vendor_id(), dev.product_id())))
        .find(|dev| match selector {
            GsUsbSelector::Serial(serial) => dev.serial_number() == Some(serial.as_str()),
            GsUsbSelector::BusAddress(bus, address) => {
                dev.bus_id().parse::<u8>().ok() == Some(*bus) && dev.device_address() == *address
            }
        })
        .ok_or_else(|| "No such gs_usb device".to_owned())
}

/// Opens the device a second time, apart from `print_topology`'s.
fn discover_endpoints(device_info: &DeviceInfo) -> Result<BulkEndpoints, String> {
    let device = device_info
        .open()
        .wait()
        .map_err(|e| format!("Failed to open device for endpoint discovery: {}", e))?;
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

fn print_topology(device_info: &DeviceInfo) -> Result<(), String> {
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
        println!(
            "\n  Interface {} (from enumeration):",
            iface.interface_number()
        );
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
                println!("\n    Interface {}:", iface_group.interface_number());
                for alt in iface_group.alt_settings() {
                    println!("      Alt Setting {}:", alt.alternate_setting());
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
                fclk,
                fclk as f64 / 1_000_000.0
            );
            let (t1min, t1max) = (bt.nominal.tseg1_min, bt.nominal.tseg1_max);
            let (t2min, t2max) = (bt.nominal.tseg2_min, bt.nominal.tseg2_max);
            let sjw = bt.nominal.sjw_max;
            let (bmin, bmax, binc) = (bt.nominal.brp_min, bt.nominal.brp_max, bt.nominal.brp_inc);
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
        (
            can_feature::REQ_USB_QUIRK_LPC546XX,
            "REQ_USB_QUIRK_LPC546XX",
        ),
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

fn query_device_config(interface: &Interface) -> Result<DeviceConfig, String> {
    let data = interface
        .control_in(
            ControlIn {
                control_type: ControlType::Vendor,
                recipient: Recipient::Interface,
                request: Breq::DeviceConfig as u8,
                value: 1,
                index: 0,
                length: DeviceConfig::SIZE as u16,
            },
            CONTROL_TIMEOUT,
        )
        .wait()
        .map_err(|e| format!("DeviceConfig query failed: {:?}", e))?;

    DeviceConfig::from_bytes(&data).ok_or_else(|| {
        format!(
            "Incomplete DeviceConfig: got {} bytes, expected {}",
            data.len(),
            DeviceConfig::SIZE
        )
    })
}

fn query_bt_const(interface: &Interface) -> Result<BtConst, String> {
    let data = interface
        .control_in(
            ControlIn {
                control_type: ControlType::Vendor,
                recipient: Recipient::Interface,
                request: Breq::BtConst as u8,
                value: 0,
                index: 0,
                length: BtConst::SIZE as u16,
            },
            CONTROL_TIMEOUT,
        )
        .wait()
        .map_err(|e| format!("BT_CONST query failed: {:?}", e))?;

    BtConst::from_bytes(&data).ok_or_else(|| {
        format!(
            "Incomplete BT_CONST: got {} bytes, expected {}",
            data.len(),
            BtConst::SIZE
        )
    })
}
