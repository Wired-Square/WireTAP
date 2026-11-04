# CANable Setup

This guide covers setting up CANable and CANable Pro devices with both SLCAN and candleLight (gs_usb) firmwares.

<!-- Screenshot: CANable device -->

## Overview

CANable is a popular USB-to-CAN adapter available in two versions:
- **CANable** - Original version with STM32F042
- **CANable Pro** - Enhanced version with STM32F072, isolated CAN transceiver

Both devices support two firmware options that work with WireTAP:

| Firmware | Protocol | WireTAP Profile | Platform Support |
|----------|----------|----------------|------------------|
| **SLCAN** | Serial ASCII | slcan | All (Windows, macOS, Linux) |
| **candleLight** | gs_usb | gs_usb (Windows, macOS) / SocketCAN (Linux) | All platforms |

gs_usb (candleLight) is the recommended firmware.

## Choosing a Firmware

### SLCAN Firmware

**Pros:**
- Works out of the box on all platforms
- No driver installation required
- Simple serial interface

**Cons:**
- Lower throughput (ASCII encoding overhead)
- No hardware timestamping
- Limited error frame support

**Best for:** Quick setup, cross-platform use, lower-speed buses

CAN FD over slcan needs Elmue's CANable firmware, which adds the data-phase bitrate commands.

### candleLight (gs_usb) Firmware

**Pros:**
- Higher throughput (binary protocol)
- Hardware timestamps
- Full error frame support
- No serial port, baud rate or COM port to configure
- Native SocketCAN support on Linux

**Cons:**
- On Windows the WinUSB driver normally installs itself, but occasionally needs installing by hand

**Best for:** High-speed capture, Linux integration, professional use

## Firmware Sources

### Recommended: Elmue's CANable 2.5 Firmware

Elmue's firmware is maintained and supports both slcan and candleLight (gs_usb) modes:
- **Repository:** https://github.com/Elmue/CANable-2.5-firmware-Slcan-and-Candlelight
- **Firmware updater (Windows):** https://www.netcult.ch/elmue/CANable%20Firmware%20Update/

It includes:
- Windows GUI flashing tool
- Both slcan and candleLight modes
- CAN FD over slcan
- Additional configuration options

### Upstream candleLight

The original candleLight firmware is at https://github.com/normaldotcom/candleLight_fw, with pre-built binaries in its GitHub Releases. It is no longer actively developed, so prefer Elmue's firmware.

## Flashing Firmware

### Method 1: DFU Mode (Recommended)

The CANable enters DFU (Device Firmware Update) mode when the BOOT jumper is set:

1. **Enter DFU Mode**
   - Disconnect the CANable from USB
   - Set the BOOT jumper (or hold BOOT button on Pro)
   - Connect to USB
   - The device should appear as "STM32 BOOTLOADER"

2. **Flash with dfu-util (Linux/macOS)**
   ```bash
   # Install dfu-util
   # macOS: brew install dfu-util
   # Linux: sudo apt install dfu-util

   # List DFU devices
   dfu-util -l

   # Flash candlelight firmware
   dfu-util -d 0483:df11 -c 1 -i 0 -a 0 -s 0x08000000:leave -D candleLight_fw.bin
   ```

3. **Flash with STM32CubeProgrammer (Windows)**
   - Download STM32CubeProgrammer from ST
   - Connect in DFU mode
   - Select the firmware .bin file
   - Click "Download"

4. **Exit DFU Mode**
   - Disconnect from USB
   - Remove the BOOT jumper
   - Reconnect

### Method 2: WireTAP's Serial App

WireTAP can write a firmware image to a CANable in DFU mode itself, on any platform:

1. Put the CANable in DFU mode (BOOT jumper set, then connect USB)
2. Open the **Serial** app and go to its **Flash** tab
3. Click **Choose DFU device** and pick the STM32 bootloader (`0x0483:0xdf11`)
4. Choose the firmware file (`.bin`, `.dfu` or `.hex`); the address defaults to `0x08000000`
5. Flash, then remove the BOOT jumper and reconnect

WireTAP doesn't switch a running CANable into DFU mode for you; set the BOOT jumper first.

### Method 3: Elmue Windows Tool

For Windows users who prefer a GUI:

1. Download the tool from https://www.netcult.ch/elmue/CANable%20Firmware%20Update/
2. Extract the archive
3. Connect CANable in DFU mode (BOOT jumper set)
4. Run the flashing tool
5. Select firmware type (SLCAN or Candlelight)
6. Click Flash
7. Remove BOOT jumper and reconnect

## Post-Flash Setup

### SLCAN on All Platforms

After flashing SLCAN firmware:

1. The device appears as a serial port:
   - Windows: `COM3` (or similar)
   - macOS: `/dev/tty.usbmodem*`
   - Linux: `/dev/ttyACM0`

2. In WireTAP Settings:
   - Create an **slcan** profile
   - Select the serial port; WireTAP checks the device and shows its firmware version
   - Choose the CAN bitrate
   - Silent mode is on by default (no ACK, no transmit); turn it off to transmit

3. No additional setup required

### Candlelight on Linux (SocketCAN)

The gs_usb driver is built into the Linux kernel:

1. Connect the device
2. It appears as a SocketCAN interface:
   ```bash
   ip link show
   # Look for can0 or similar
   ```

3. Bring up the interface:
   ```bash
   sudo ip link set can0 up type can bitrate 500000
   ```

4. In WireTAP Settings:
   - Create a **SocketCAN** profile
   - Enter the interface name (`can0`)
   - Optionally set a bitrate, and WireTAP brings the interface up itself when the session starts, asking for your password

### Candlelight on Windows

1. **Install WinUSB Driver** (only if the device isn't listed in WireTAP; it normally installs automatically)
   - Download Zadig: https://zadig.akeo.ie/
   - Connect the CANable
   - Run Zadig
   - Select the CANable device
   - Choose WinUSB driver
   - Click "Install Driver"

2. In WireTAP Settings:
   - Create a **gs_usb** profile
   - Select the device from the dropdown
   - Set the bitrate
   - Listen-only mode is on by default; turn it off to transmit

### Candlelight on macOS

WireTAP uses nusb for direct USB access on macOS:

1. Connect the CANable
2. In WireTAP Settings:
   - Create a **gs_usb** profile
   - Select the device
   - Set the bitrate
   - Listen-only mode is on by default; turn it off to transmit

No additional driver installation required.

## Verifying the Firmware

### Check SLCAN

```bash
# Linux/macOS - connect at 115200 baud
screen /dev/ttyACM0 115200

# Type 'V' and press Enter - should return version
V
# Response: V1013 (or similar)

# Exit screen with Ctrl+A, then K, then Y
```

### Check Candlelight (Linux)

```bash
# Should show can0 interface
ip link show can0

# Check detailed info
ip -details link show can0
```

### Check in WireTAP

1. Create an appropriate profile (slcan, gs_usb or SocketCAN); the profile dialog checks the device and shows its firmware or features
2. Open Discovery
3. Pick the profile in the data source picker
4. Click **Connect**
5. Status indicator should turn green

## Troubleshooting

### Device Not Detected

**Windows:**
- Check Device Manager for unknown devices
- Try a different USB port
- Use Zadig to install WinUSB driver

**Linux:**
- Check `dmesg` for connection messages
- Verify user is in `dialout` group: `sudo usermod -a -G dialout $USER`
- Log out and back in after group change

**macOS:**
- Check System Information > USB
- Try different USB port or hub

### DFU Mode Not Working

- Ensure BOOT jumper is correctly placed
- Try holding the BOOT button while connecting USB
- Check for damaged jumper pins
- Some clones may have different boot procedures

### SLCAN Communication Errors

- Verify correct serial port selected
- Check baud rate matches (usually 115200)
- Ensure no other software has the port open
- Try disconnecting and reconnecting

### SocketCAN Interface Won't Come Up

```bash
# Check for errors
dmesg | tail -20

# Try bringing down first
sudo ip link set can0 down

# Then up with explicit settings
sudo ip link set can0 up type can bitrate 500000 restart-ms 100
```

## Hardware Termination

CAN buses require 120Ω termination at each end. The CANable:
- **CANable (original):** Has a termination jumper - enable if needed
- **CANable Pro:** Has switchable termination

If you're connecting to an already-terminated bus, leave termination disabled.

## See Also

- [Supported Hardware](supported-hardware.md) - Other compatible devices
- [Settings](settings.md#io-profiles) - Creating IO profiles
- [Discovery](discovery.md) - Start capturing data
