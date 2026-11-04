# Installation

WireTAP is available for Windows, macOS, and Linux. Download the latest release for your platform and follow the instructions below.

## Download

Download the latest release from the [GitHub Releases](https://github.com/Wired-Square/WireTAP/releases) page.

| Platform | File | Notes |
|----------|------|-------|
| Windows (x64) | `WireTAP_x.x.x_Windows_x64.exe` | Installer |
| macOS (Apple Silicon) | `WireTAP_x.x.x_macOS_arm64.pkg` | Installer package |
| macOS (Intel) | `WireTAP_x.x.x_macOS_x64.pkg` | Installer package |
| Linux (x64) | `WireTAP_x.x.x_Linux_x64.deb` | Debian package |
| Linux (x64) | `WireTAP_x.x.x_Linux_x64.AppImage` | Portable |
| Linux (arm64) | `WireTAP_x.x.x_Linux_arm64.deb` | Debian package |
| Linux (arm64) | `WireTAP_x.x.x_Linux_arm64.AppImage` | Portable |

Every installer also carries `wiretap-can-cli`, a command-line tool in the style of can-utils (`dump`, `send`, `gen` and more) for the same CAN adapters WireTAP drives. The Windows installer, the macOS package and the `.deb` put it on your PATH.

## Windows

### Using the Installer (.exe)

1. Download `WireTAP_x.x.x_Windows_x64.exe`
2. Run the installer
3. Follow the installation wizard
4. Launch WireTAP from the Start Menu

The installer adds its install directory to PATH, so `wiretap-can-cli` runs from a new terminal.

### Driver Installation

Some CAN adapters require drivers:

- **CANable with candleLight (gs_usb) firmware** - The WinUSB driver normally installs automatically; if the device isn't listed, install WinUSB with [Zadig](https://zadig.akeo.ie/)
- **Serial devices (SLCAN, GVRET)** - Usually auto-detected, may need manufacturer drivers

See [CANable Setup](canable-setup.md) for detailed driver instructions.

## macOS

WireTAP needs macOS 13 (Ventura) or later.

### Using the Installer Package (.pkg)

1. Download the package for your Mac:
   - Apple Silicon: `WireTAP_x.x.x_macOS_arm64.pkg`
   - Intel Mac: `WireTAP_x.x.x_macOS_x64.pkg`
2. Open the package and follow the installer
3. Launch WireTAP from Applications

The package installs `WireTAP.app` in `/Applications` and links `wiretap-can-cli` into `/usr/local/bin`.

### First Launch

Release builds are signed and notarised, so they open normally. If macOS blocks a build that wasn't notarised, remove the quarantine flag:

```bash
sudo xattr -dr com.apple.quarantine /Applications/WireTAP.app
```

Then open WireTAP normally from Applications.

Alternatively, if you prefer the GUI approach:

1. Try to open WireTAP - you'll see a warning
2. Go to **System Settings** → **Privacy & Security**
3. Scroll down and click **Open Anyway**
4. Confirm by clicking **Open**


### Permissions

- gs_usb devices (CANable with candleLight firmware) need no driver; WireTAP talks to them directly over USB
- macOS may ask to allow WireTAP on the **local network**: allow it to reach GVRET TCP devices, FrameLink devices and a WireTAP backend on your LAN
- macOS may ask for **Bluetooth** access, used to set up and upgrade FrameLink devices

## Linux

Packages are built for x64 (`Linux_x64`) and arm64 (`Linux_arm64`). Substitute your architecture in the file names below.

### Debian/Ubuntu (.deb)

```bash
# Download the package
wget https://github.com/Wired-Square/WireTAP/releases/download/vX.X.X/WireTAP_x.x.x_Linux_x64.deb

# Install, with its dependencies
sudo apt install ./WireTAP_x.x.x_Linux_x64.deb
```

The `.deb` also installs `wiretap-can-cli` on PATH.

### Other Distributions (AppImage)

There is no `.rpm` package; on Fedora, RHEL and other distributions use the AppImage.

```bash
# Download
wget https://github.com/Wired-Square/WireTAP/releases/download/vX.X.X/WireTAP_x.x.x_Linux_x64.AppImage

# Make executable
chmod +x WireTAP_x.x.x_Linux_x64.AppImage

# Run
./WireTAP_x.x.x_Linux_x64.AppImage
```

### Linux Prerequisites

#### Serial Port Access

Add your user to the `dialout` group for serial device access:

```bash
sudo usermod -a -G dialout $USER
```

Log out and back in for the change to take effect.

#### SocketCAN Setup

For native CAN interfaces, load the kernel modules:

```bash
sudo modprobe can
sudo modprobe can_raw
```

Bring up your CAN interface:

```bash
sudo ip link set can0 up type can bitrate 500000
```

Alternatively, set a bitrate in the SocketCAN profile and WireTAP configures the interface itself when the session starts, asking for your password. Leave the bitrate empty to use the interface as the system configured it.

See [Supported Hardware](supported-hardware.md) for more details.

## Building from Source

[CONTRIBUTING.md](../../CONTRIBUTING.md) is the full guide; this is the short version.

### Prerequisites

- **Node.js** 22 and npm
- **Rust** 1.99 (the version CI builds with)
- **System dependencies** (varies by platform, below)

### Clone and Build

The shared `wslib-*` crates come from the Wired Square Cargo registry. Point Cargo at its public mirror once per machine; npm needs no setup.

```bash
# Clone the repository
git clone https://github.com/Wired-Square/WireTAP.git
cd WireTAP

# Read the wslib crates from the registry mirror
cat .cargo/mirror.toml >> ~/.cargo/config.toml

# Install dependencies
npm install

# Run in development mode
npm run tauri:dev

# Build installers for this platform
bash scripts/tauri.sh build
```

### Platform-Specific Dependencies

#### Windows

Install Visual Studio Build Tools with the "Desktop development with C++" workload, and WebView2 if it isn't already present.

#### macOS

```bash
xcode-select --install
```

#### Linux (Debian/Ubuntu)

```bash
sudo apt install build-essential \
    libwebkit2gtk-4.1-dev \
    libappindicator3-dev \
    librsvg2-dev \
    patchelf \
    libudev-dev \
    xdg-utils
```

On other distributions, install the equivalents of these and the [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/).

## Post-Installation Setup

After installing WireTAP:

1. **Set up directories** - Go to [Settings](settings.md#locations) and configure your decoder and dump directories
2. **Configure hardware** - Create an [IO profile](settings.md#io-profiles) for your CAN adapter
3. **Flash firmware** (if needed) - See [CANable Setup](canable-setup.md) for adapter preparation

## Updating

WireTAP checks GitHub for a newer release when it starts, and shows **Update available** in the logo menu when there is one; clicking it opens the release page. It doesn't install updates itself. To update:

1. Download the latest release from GitHub
2. Install over the existing version (settings are preserved)

## Uninstalling

### Windows

Use **Settings** → **Apps** → **WireTAP** → **Uninstall**

Or via Control Panel → Programs and Features

### macOS

Drag WireTAP from Applications to Trash, and remove the command-line link:

```bash
sudo rm /usr/local/bin/wiretap-can-cli
```

### Linux

```bash
# Debian/Ubuntu: find the package's name, then remove it
dpkg -l | grep -i tap
sudo apt remove <package-name>

# AppImage - just delete the file
rm WireTAP_x.x.x_Linux_x64.AppImage
```

## See Also

- [Supported Hardware](supported-hardware.md) - Compatible CAN interfaces
- [CANable Setup](canable-setup.md) - Firmware and driver setup
- [Settings](settings.md) - Initial configuration
