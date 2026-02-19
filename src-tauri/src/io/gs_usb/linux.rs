// src-tauri/src/io/gs_usb/linux.rs
//
// gs_usb device enumeration for Linux using sysfs.
//
// On Linux, gs_usb devices are handled by the kernel gs_usb driver, which
// exposes them as SocketCAN interfaces (can0, can1, etc.). This module
// enumerates these devices and maps them to their SocketCAN interface names.
//
// The actual reading/writing is done by the existing SocketCAN reader.

use std::fs;
use std::path::Path;

use super::{GsUsbDeviceInfo, GS_USB_PIDS, GS_USB_VID};

/// List all gs_usb devices on the system by scanning sysfs.
///
/// For each CAN interface, we check if its parent USB device matches
/// the gs_usb VID/PID. If so, we include it in the list.
pub fn list_devices() -> Result<Vec<GsUsbDeviceInfo>, String> {
    let mut devices = Vec::new();

    // Scan /sys/class/net/ for CAN interfaces
    let net_path = Path::new("/sys/class/net");
    if !net_path.exists() {
        return Ok(devices);
    }

    let entries = fs::read_dir(net_path).map_err(|e| format!("Failed to read /sys/class/net: {}", e))?;

    for entry in entries.flatten() {
        let iface_name = entry.file_name().to_string_lossy().to_string();

        // Only look at CAN interfaces (canX)
        if !iface_name.starts_with("can") {
            continue;
        }

        // Check if this is a gs_usb device by looking at the USB parent
        if let Some(device_info) = get_gs_usb_info_for_interface(&iface_name) {
            devices.push(device_info);
        }
    }

    // Also scan USB devices that might not have a CAN interface yet
    // (device is connected but kernel driver hasn't bound yet)
    if let Ok(usb_devices) = scan_unbound_gs_usb_devices() {
        for dev in usb_devices {
            // Only add if not already in the list (by bus:address)
            if !devices.iter().any(|d| d.bus == dev.bus && d.address == dev.address) {
                devices.push(dev);
            }
        }
    }

    Ok(devices)
}

/// Get gs_usb device info for a specific CAN interface
fn get_gs_usb_info_for_interface(iface_name: &str) -> Option<GsUsbDeviceInfo> {
    let device_path = format!("/sys/class/net/{}/device", iface_name);
    let _device_link = fs::read_link(&device_path).ok()?;

    // The device link points to something like:
    // ../../../devices/pci0000:00/0000:00:14.0/usb1/1-1/1-1:1.0
    // We need to go up to the USB device level (1-1 in this case)

    // Follow the symlink to get the full path
    let device_full_path = fs::canonicalize(&device_path).ok()?;

    // Look for idVendor and idProduct in parent directories
    let mut current_path = device_full_path.as_path();

    while let Some(parent) = current_path.parent() {
        let vendor_path = parent.join("idVendor");
        let product_path = parent.join("idProduct");

        if vendor_path.exists() && product_path.exists() {
            let vendor_str = fs::read_to_string(&vendor_path).ok()?;
            let product_str = fs::read_to_string(&product_path).ok()?;

            let vendor = u16::from_str_radix(vendor_str.trim(), 16).ok()?;
            let product = u16::from_str_radix(product_str.trim(), 16).ok()?;

            if vendor == GS_USB_VID && GS_USB_PIDS.contains(&product) {
                // Found a gs_usb device!
                let busnum = fs::read_to_string(parent.join("busnum"))
                    .ok()
                    .and_then(|s| s.trim().parse::<u8>().ok())
                    .unwrap_or(0);

                let devnum = fs::read_to_string(parent.join("devnum"))
                    .ok()
                    .and_then(|s| s.trim().parse::<u8>().ok())
                    .unwrap_or(0);

                let product_name = fs::read_to_string(parent.join("product"))
                    .ok()
                    .map(|s| s.trim().to_string())
                    .unwrap_or_else(|| "candleLight".to_string());

                let serial = fs::read_to_string(parent.join("serial"))
                    .ok()
                    .map(|s| s.trim().to_string());

                // Check if interface is up
                let operstate_path = format!("/sys/class/net/{}/operstate", iface_name);
                let interface_up = fs::read_to_string(&operstate_path)
                    .ok()
                    .map(|s| s.trim() == "up");

                return Some(GsUsbDeviceInfo {
                    bus: busnum,
                    address: devnum,
                    product: product_name,
                    serial,
                    interface_name: Some(iface_name.to_string()),
                    interface_up,
                });
            }
        }

        current_path = parent;
    }

    None
}

/// Scan for gs_usb devices that don't have a CAN interface yet
fn scan_unbound_gs_usb_devices() -> Result<Vec<GsUsbDeviceInfo>, String> {
    let mut devices = Vec::new();

    // Scan /sys/bus/usb/devices/
    let usb_path = Path::new("/sys/bus/usb/devices");
    if !usb_path.exists() {
        return Ok(devices);
    }

    let entries = fs::read_dir(usb_path).map_err(|e| format!("Failed to read USB devices: {}", e))?;

    for entry in entries.flatten() {
        let path = entry.path();

        // Skip interfaces (contain ':')
        let name = entry.file_name().to_string_lossy().to_string();
        if name.contains(':') {
            continue;
        }

        // Check for idVendor and idProduct
        let vendor_path = path.join("idVendor");
        let product_path = path.join("idProduct");

        if !vendor_path.exists() || !product_path.exists() {
            continue;
        }

        let vendor_str = match fs::read_to_string(&vendor_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let product_str = match fs::read_to_string(&product_path) {
            Ok(s) => s,
            Err(_) => continue,
        };

        let vendor = match u16::from_str_radix(vendor_str.trim(), 16) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let product = match u16::from_str_radix(product_str.trim(), 16) {
            Ok(p) => p,
            Err(_) => continue,
        };

        if vendor == GS_USB_VID && GS_USB_PIDS.contains(&product) {
            let busnum = fs::read_to_string(path.join("busnum"))
                .ok()
                .and_then(|s| s.trim().parse::<u8>().ok())
                .unwrap_or(0);

            let devnum = fs::read_to_string(path.join("devnum"))
                .ok()
                .and_then(|s| s.trim().parse::<u8>().ok())
                .unwrap_or(0);

            let product_name = fs::read_to_string(path.join("product"))
                .ok()
                .map(|s| s.trim().to_string())
                .unwrap_or_else(|| "candleLight".to_string());

            let serial = fs::read_to_string(path.join("serial"))
                .ok()
                .map(|s| s.trim().to_string());

            devices.push(GsUsbDeviceInfo {
                bus: busnum,
                address: devnum,
                product: product_name,
                serial,
                interface_name: None, // No CAN interface bound yet
                interface_up: None,
            });
        }
    }

    Ok(devices)
}

/// Find the CAN interface name for a specific USB device
pub fn find_interface_for_device(bus: u8, address: u8) -> Option<String> {
    let devices = list_devices().ok()?;
    devices
        .into_iter()
        .find(|d| d.bus == bus && d.address == address)
        .and_then(|d| d.interface_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_list_devices_no_panic() {
        // This shouldn't panic even on systems without gs_usb devices
        let _ = list_devices();
    }
}
