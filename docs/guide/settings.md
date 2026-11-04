# Settings

The Settings panel lets you configure WireTAP's behaviour, set up IO profiles for your hardware and data sources, and manage your catalogs and directories.

<img width="899" height="711" alt="Screenshot 2026-02-28 at 5 12 58 pm" src="https://github.com/user-attachments/assets/5824ab01-d184-4519-9194-f5ee2c4fb60c" />

## Sections

### Locations

The **Storage** section configures where WireTAP stores and reads files:

| Setting | Description |
|---------|-------------|
| **Decoder Directory** | Folder containing your signal catalogs (`.toml` files) |
| **Dump Directory** | Folder where CAN bus dump files are stored |
| **Report Directory** | Default folder for exported analysis reports |
| **Save frame ID format** | Hex or decimal, used for default decoder file names when saving or creating catalogs |

Click the folder icon to select a directory. Each directory is checked and flagged if it does not exist or is not writable.

### Display Settings

Customise how data is shown throughout the application:

#### Appearance

Choose **Light** or **Dark**, or **System** to follow your operating system. **Theme Colours** lets you customise the light, dark and accent colours, with **Reset All** to go back to the defaults.

#### Frame ID Format

Choose how frame identifiers are displayed: **Hex** (default) or **Decimal**.

#### Time Format

Select how timestamps are displayed:
- **Human friendly** (default)
- **Timestamp**
- **Delta since start**
- **Delta since last message**

**Default timezone** sets local time or UTC for clock displays. Click the timezone badge in a view to override it temporarily.

#### Signal Colours

Colours for signal confidence indicators:
- **No confidence**
- **Low confidence**
- **Medium confidence**
- **High confidence**

#### Binary Display

Colours for bit displays in the Calculator and bit previews:
- **Binary 1 colour** - Set bits
- **Binary 0 colour** - Cleared bits
- **Unused bits colour** - Padding/unused bits

#### Frame Editor

Colours for the signal slots in the frame definition bit grid editor.

### IO Profiles

IO profiles, under **Data IO**, define how WireTAP connects to CAN hardware and data sources. Each profile stores the complete configuration for a specific device or connection.

#### Creating a Profile

1. Click **+ Profile**
2. Select the type (see [Supported Hardware](supported-hardware.md))
3. Enter a descriptive name
4. Optionally choose a **Preferred Decoder** to load with this source
5. Configure the type-specific settings
6. Click **Add Profile**

#### Profile Types

| Type | Settings |
|------|----------|
| **FrameLink** | Host, port |
| **gs_usb (candleLight)** | Device selection, bitrate, sample point, listen-only, CAN FD |
| **GVRET TCP** | Host address, port |
| **GVRET USB (Serial)** | Serial port, baud rate |
| **Modbus TCP** | Host, port, unit ID |
| **MQTT** | Broker host, port, credentials, message formats |
| **WireTAP Backend** | Backend URL, API key, capture database |
| **Serial Port** | Port, baud, data bits, stop bits, parity |
| **slcan (CANable, USB-CAN)** | Serial port, CAN bitrate, silent mode, CAN FD |
| **SocketCAN (Linux)** | Interface name (e.g., `can0`), optional bitrate, CAN FD |
| **Virtual Adapter (Testing)** | Traffic type, loopback, interfaces, signal generator |

CSV files are not a profile type: import them from the Data Source picker.

#### Editing a Profile

1. Click the edit button on the profile
2. Modify settings as needed
3. Click **Update Profile** to apply changes

Profiles can also be duplicated or deleted from the same row.

#### Default Read Profile

Set which profile apps open on by default:
1. Find the profile in the list
2. Click the star (**Set as default**)

The default profile's star is filled in.

#### Unsaved Devices

Devices created in a source picker are kept for the current run only and appear under **Unsaved devices**. Click **Save to Settings** to keep one after a restart, or **Discard** it.

### Catalogs

Manage your signal catalog files from the decoder directory. Each catalog's menu offers:

| Action | Description |
|--------|-------------|
| **Duplicate** | Create a copy of an existing catalog |
| **Edit name/filename** | Rename the catalog or its file |
| **Delete** | Remove a catalog file |

Catalogs pulled from a Git repository keep a link to it and show their status. Their menu adds **Pull latest**, **Push changes…**, opening the repository or pull request on GitHub, revealing the local clone, and **Stop tracking the Git source**. **Check for updates** checks every tracked repository, and **Connect GitHub** signs in for pushing.

### Captures

Capture storage and buffer limits:

| Setting | Description |
|---------|-------------|
| **Clear captures on start** | Delete all captured data when the app launches (default: on). Turn off to keep captures across restarts |
| **Discovery History Buffer** | How many of a live stream's most recent frames Frame Order and Payload Changes analyse (default 100,000) |
| **Query Result Limit** | Maximum results a query returns in the [Query](query.md) app (100–100,000, default 10,000) |
| **Dashboard Buffer Size** | Samples per signal kept by the [Dashboard](dashboard.md) (1,000–100,000, default 10,000) |
| **Decoder Limits** | Maximum unmatched, filtered and decoded frames kept by the Decoder |
| **Max History Items** | Transmitted frames kept in the Transmit history log (default 1,000) |

### Devices

Scan for network and Bluetooth devices, connect to them, provision their Wi-Fi, and upgrade their firmware. A device that is not found by scanning can be added by IP address.

### Selection Sets and Dashboard Layouts

Edit or delete the selection sets saved from the Decoder or Discovery, and the layouts saved from the [Dashboard](dashboard.md).

### MCP Server

Lets an external MCP client (such as an AI assistant) read WireTAP's live state over a local connection. Off by default. Each group of tools that can change things (control, session open/stop, catalog create and modify, dashboard write, UI control) has its own switch. Set the port (default 8787) and an optional access token here.

### Privacy

Opt in or out of anonymous crash reports and, separately, anonymous usage analytics. Neither collects CAN bus data or personal data.

### General

Miscellaneous application settings:

| Setting | Description |
|---------|-------------|
| **Default Frame Type** | CAN, Modbus or Serial when adding new frames |
| **Max Consecutive Register Errors** | Stop polling a Modbus register group after this many errors in a row (0 retries forever; default 3) |
| **Power Management** | Keep the system, and optionally the display, awake during active sessions |
| **Log Level** | Diagnostic log verbosity: Off (default), Info, Debug or Verbose |
| **SMP UDP Port** | Default port for firmware upgrades over UDP (default 1337) |
| **Display Language** | Language used throughout the interface |

## IO Profile Configuration Details

### GVRET USB

For ESP32-RET, M2RET, or CANDue devices connected via USB:

| Setting | Description |
|---------|-------------|
| **Serial Port** | Serial port (e.g., `COM3`, `/dev/ttyUSB0`) |
| **Serial Baud Rate** | Default 115200 |

### GVRET TCP

For remote GVRET servers (e.g., [WireTAP Server](wiretap-server.md) on Raspberry Pi):

| Setting | Description |
|---------|-------------|
| **Host** | IP address or hostname |
| **Port** | TCP port (default: 23) |
| **Connection Timeout** | Seconds to wait for a connection (default: 5) |
| **CAN Interfaces** | Save the profile, then click **Probe Device** to detect the buses |

### slcan

For CANable and similar devices with SLCAN firmware:

| Setting | Description |
|---------|-------------|
| **Serial Port** | Serial port |
| **CAN Bitrate** | CAN bus speed (10 Kbit/s to 1 Mbit/s; default 500 Kbit/s) |
| **Silent Mode** | No ACK, no transmit (on by default) |
| **Enable CAN FD** | With a data phase bitrate; needs ELMUE CANable firmware with CAN FD support |

See [CANable Setup](canable-setup.md) for firmware instructions.

### SocketCAN (Linux)

For native Linux CAN interfaces:

| Setting | Description |
|---------|-------------|
| **Interface Name** | Interface name (e.g., `can0`, `vcan0`) |
| **CAN Bitrate** | Optional. When set, WireTAP configures the interface itself (requires authentication) |
| **Enable CAN FD** | With a data phase bitrate; needs FD-capable hardware |

Leave the bitrate empty to use the interface as the system has configured it, for example:
```bash
sudo ip link set can0 up type can bitrate 500000
```

### gs_usb

For candleLight/gs_usb firmware devices:

| Setting | Description |
|---------|-------------|
| **Device** | Select from detected devices |
| **CAN Bitrate** | CAN bus speed (default 500 Kbit/s) |
| **Sample Point** | Default 87.5% |
| **Listen-only mode** | No ACK, no transmit (on by default) |
| **Enable CAN FD** | With a data phase bitrate and sample point |

See [CANable Setup](canable-setup.md) for firmware instructions.

### Serial Port

For custom serial protocols:

| Setting | Description |
|---------|-------------|
| **Port** | Serial port |
| **Baud Rate** | Communication speed (default 115200) |
| **Data Bits** | Default 8 |
| **Stop Bits** | Default 1 |
| **Parity** | None, Odd, Even |

Framing is chosen per session in the Data Source picker, not on the profile.

### WireTAP Backend

For reading the long-term archive held by a WireTAP backend gateway (see [WireTAP Server](wiretap-server.md)). The backend owns the database; WireTAP connects over its HTTP API and needs no database credentials.

| Setting | Description |
|---------|-------------|
| **Backend URL** | Gateway address (default `http://localhost:8423`) |
| **API Key** | Key issued by the backend |
| **Capture Database** | Database to read (default `wiretap`) |
| **Protocol** | CAN (default) or Modbus (whole RTU messages) |
| **Default Playback Speed** | Speed used when replaying from this source |

The editor contacts the gateway as you type and shows its version and the databases it holds. Used by the [Query](query.md) app and for replaying recorded data.

## Tips

- Create multiple profiles for different vehicles or test setups
- Use descriptive names like "Car - OBD Port" or "Test Bench - HS CAN"
- The Discovery History Buffer affects memory usage; adjust based on your system
- Set a default profile to speed up your workflow

## See Also

- [Supported Hardware](supported-hardware.md) - Compatible devices and requirements
- [CANable Setup](canable-setup.md) - Firmware configuration for CANable devices
- [WireTAP Server](wiretap-server.md) - Remote CAN capture setup
