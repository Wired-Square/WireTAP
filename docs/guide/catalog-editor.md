# Catalog Editor

The Catalog Editor provides a visual interface for creating and editing the signal catalogues used by the Decoder.

<img width="943" height="755" alt="Screenshot 2026-02-28 at 5 16 55 pm" src="https://github.com/user-attachments/assets/45c317d7-e731-40e3-8ded-7209519d5983" />

## Overview

Signal catalogues are TOML files that define how raw CAN, serial and Modbus frames are decoded into meaningful signals. The Catalog Editor lets you build these definitions visually or edit the raw TOML directly. Edits keep the file's comments and formatting.

## Editing Modes

### GUI Mode

A tree-based visual editor with:
- Hierarchical navigation (Metadata → Frames → Signals → Mux Cases)
- A detail view and edit dialogs for each element
- Byte and bit layout previews for frames, mux cases and signals
- A search box above the tree

### Text Mode

Raw TOML editing with:
- Line numbers
- **Edit** and **Diff** views; Diff shows the changes since the last save
- Find (Cmd/Ctrl+F)
- Full control over the file format

Toggle between modes with **Switch to Text Mode** / **Switch to GUI Mode** in the toolbar.

## Catalogue Structure

### Metadata

Top-level catalogue information, edited with **Catalog configuration** (the gear button):
- **Name** - Display name for the catalogue
- **Version** - A whole number, counting the catalogue's revisions (the push dialog offers to bump it)

The same dialog holds each protocol's settings: default byte order and interval, CAN's frame ID mask and header fields, serial encoding and checksum, and Modbus device address, register base and word order.

### Protocols

Each catalogue can define frames for several protocols:

| Protocol | Use Case |
|----------|----------|
| **CAN** | CAN and CAN FD bus communication |
| **Serial** | Serial protocols framed by SLIP, a delimiter or Modbus RTU |
| **Modbus** | Modbus registers read from one or more slaves |

### Nodes

Nodes name the devices on the bus. A CAN frame can name its transmitting node; a Modbus register belongs to a slave node, which holds its device address.

### Frames

Frame definitions include:
- **ID** - Frame identifier (hex or decimal for CAN; a name for serial and Modbus frames)
- **Length** - Data length in bytes (in registers for Modbus)
- **Transmitter** - The node that sends it
- **Interval** - Expected transmission interval (ms)
- **Extended ID** and **CAN FD** - For CAN frames, inherited from the CAN defaults unless set
- **Copy From** / **Mirror Of** - Inherit metadata, or all signals, from another frame
- **Notes** - Purpose of this message
- **Signals** - List of signals within the frame

### Signals

Signal definitions include:

| Property | Description |
|----------|-------------|
| **Name** | Signal identifier |
| **Start Bit** | Position in the frame (0-indexed) |
| **Bit Length** | Size in bits |
| **Byte Order** | Big-endian or Little-endian, or inherited from the defaults |
| **Signed** | Whether the raw value is signed |
| **Format** | Number, Enum, UTF-8, ASCII, Hex or Unix Time |
| **Factor** | Multiplier for raw value |
| **Offset** | Added after scaling |
| **Unit** | Physical unit (e.g., "km/h", "°C") |
| **Confidence** | None, Low, Medium or High: how sure you are of the definition |
| **Enum Values** | Enumerated value mappings |
| **Notes** | Free text |

`min`, `max` and `precision` (fixed decimal places) can be set in Text Mode.

### Multiplexing

For frames with multiplexed content:
- **Mux** - The selector bits that choose the case, at any position and width
- **Mux Cases** - Different signal layouts based on the selector value; a case can match one value, a range or a list
- **Default Case** - Used when no case matches
- **Nested Mux** - A case can hold its own mux
- Signals outside the mux are present regardless of the selector value

### Checksums

A frame can carry checksums, each with an algorithm, position and calculation range. The Decoder reports whether each one matches.

## Creating a Catalogue

Open the catalogue picker from the toolbar button showing the catalogue's name.

### From Scratch

1. Click **New** in the picker
2. Choose the protocol type and enter the name, version and defaults
3. Click **Create Catalog**
4. Add frames with **Add new frame** in the tree
5. Add signals to each frame
6. Save the catalogue

### From Existing Data

1. Capture frames in [Discovery](discovery.md)
2. Use **Save frames to decoder** (or **Save bytes to decoder** for serial)
3. Open the saved catalogue in the Catalog Editor
4. Add signal definitions based on analysis

From the Decoder, right-click a frame and choose **Edit in Catalog** to jump to it here.

### From a DBC or TOML File

1. Click **Import** in the picker and choose a `.dbc` or `.toml` file
2. A DBC file is converted to TOML on import
3. Edit as needed in the Catalog Editor

### From a Repository

Click **Repository** in the picker to browse catalogues shared in a Git repository and import them. See [Sharing Catalogues](#sharing-catalogues).

## Tree Navigation

The left panel shows a hierarchical tree:

```
meta
frame
├── can
│   ├── 0x100
│   │   ├── RPM
│   │   ├── Coolant_Temp
│   │   └── Throttle_Position
│   └── 0x200
│       └── Gear
└── serial
    └── sensor_data
node
└── ECU
```

Click any node to view it in the right panel. **Tree**, **Frames** and **Nodes** switch the tree's view, and the protocol buttons show only one protocol's frames.

## Frame Editor

When a frame is selected:

### Basic Properties
- ID, length, transmitter, interval and notes
- Extended ID and CAN FD (CAN), register type and slave (Modbus)
- A byte layout of every signal, selector and checksum

### Default Settings
- Byte order, interval, extended ID and CAN FD are inherited from the protocol configuration unless the frame sets them

### Header Fields (CAN/Serial)
- Fields such as a frame ID or source address, set in the protocol configuration
- Checksum configuration

## Signal Editor

When a signal is selected:

### Position
- Start bit and bit length
- Bit Preview of where it sits in the frame

### Scaling
- Factor and offset
- Formula: `physical = (raw × factor) + offset`

### Unit
- Unit string

### Enumerated Values
For signals with discrete states, set **Format** to Enum and edit the values. In TOML they follow the signal:
```toml
[[frame.can."0x100".signals]]
name = "State"
start_bit = 0
bit_length = 8
format = "enum"

[frame.can."0x100".signals.enum]
0 = "Off"
1 = "On"
2 = "Error"
```

## Validation

Click **Validate catalog** in the toolbar to check the catalogue. The button turns green when it is valid and red when it is not; click it then to see each error and the field it belongs to. A catalogue in an older format is upgraded on load, with a banner to review the changes before you save.

## Export Options

Click **Export catalog** in the toolbar and choose a format:

| Format | Use |
|--------|-----|
| **TOML Catalog** | The native WireTAP format |
| **DBC File** | Vector DBC for other tools, with extended or flattened multiplexing |
| **HTML Report** | For screen or for print |
| **Markdown Report** | For documentation tools |
| **Text Report** | Plain text |

Note: Serial and Modbus frames, and some WireTAP-specific features, do not export to DBC.

## Sharing Catalogues

Catalogues can be shared through Git repositories:
- **Repository** in the picker browses a repository and imports catalogues from it
- **Publish to Git** in the toolbar pushes the saved catalogue to one of your repositories, optionally on a branch with a pull request; save your changes first
- When a tracked catalogue has changed upstream, a toolbar button lets you review the update before replacing your copy

Publishing needs a GitHub account connected in [Settings](settings.md#catalogs); importing from a public repository does not.

## Tips

- Toggle to Text Mode to copy and paste sections between catalogues
- Check the **Diff** view before saving a large edit
- Use consistent naming conventions for signals (e.g., `ECU_SignalName`)
- Add notes to help future users understand each signal
- Set a signal's confidence to show how sure you are of it; the Decoder colours values by it

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Cmd/Ctrl+F | Find (Text Mode) or focus the tree search (GUI Mode) |
| Edit → Undo / Redo | Undo or redo typing in a text field |

Saving has no shortcut; use the **Save** button, which turns red while there are unsaved changes.

## See Also

- [Decoder](decoder.md) - Use catalogues to decode frames
- [Discovery](discovery.md) - Capture frames to analyse
