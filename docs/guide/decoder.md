# Decoder

The Decoder panel turns raw frames into named signals using a TOML decoder catalogue.

<img width="812" height="828" alt="decoder-screenshot" src="https://github.com/user-attachments/assets/2fd89148-c4d9-444d-9325-579f792232f7" />

## Overview

The Decoder attaches a catalogue to a session and shows each frame's signals with their physical values and units. Decoding is done by WireTAP's backend as frames arrive, so two Decoder panels on one session, the Dashboard and Query all agree on a value. It works the same for a live device and for a recorded capture played back.

## Sources

Pick a source from the **Data Source** dialog (**Session → Select Source…**, Cmd/Ctrl+I). What you can do depends on the source:

### Connect

Stream from a live device, or from a recorded source in real time:
- Frames are decoded as they arrive
- The display updates continuously
- Frames are kept in a capture for later playback

### Load

Read a recorded source (a capture or a WireTAP Backend archive) into a capture as fast as possible, without real-time display. Loading always runs at maximum speed; play the capture back once it finishes.

### Join

Attach to a session another app or window already has open. The Decoder follows that session's playback.

### Playback

Decode a captured session:
- Play forwards or backwards, pause, and step a frame at a time
- Drag the scrubber to any point in the capture
- Choose a playback speed from 0.125x to 60x

## Interface Elements

### Catalogue Selection

Click the catalogue button in the top bar to open **Select Decoder Catalog**, or choose one in the Data Source dialog's **Decoder** slot. Catalogues are loaded from your decoder directory (set in [Settings](settings.md#locations)). The picker can also import a catalogue from a file (TOML or DBC) or browse shared catalogue repositories.

### Signals

The **Signals** tab shows one card per catalogued frame:
- The frame ID and length, with badges for header fields (such as a J1939 source address), checksum results and mirror frames
- Each signal's name, decoded value with units (or its enum label), and when it last updated
- Multiplexed signals grouped by their mux case
- Signal values coloured by the confidence set in the catalogue

Top bar toggles:

| Control | Effect |
|---------|--------|
| **Show raw bytes** | Show each frame's bytes; changed bytes flash |
| **Per source address** | Show one card per source address rather than the most recent frame |
| **Showing only seen frames** | Hide catalogued frames that have not been received |
| **Frame filters** | Move frames by ID or minimum length to the Filtered tab |
| **Clear decoded values** | Clear the current tab |

Right-click a frame or signal to copy it, send it to Transmit, add it to a Dashboard, open it in the Catalog Editor (**Edit in Catalog**) or mark an event. The calculator button on a frame sends it to the [Calculator](calculator.md).

### ASCII Column

**Show ASCII column** adds the bytes as ASCII text beside each frame in the Unmatched and Filtered tabs, which helps with text-based serial protocols.

### Tabs

| Tab | Contents |
|-----|----------|
| **Signals** | Frames decoded by the catalogue |
| **Unmatched** | Frames with no catalogue definition, including remote requests |
| **Filtered** | Frames excluded by the frame filters or the frame picker, and frames too short to decode |
| **Modbus** | Modbus RTU requests and responses, shown when the catalogue reads Modbus from a serial line, a tunnel in a CAN ID, or a Modbus archive |

## Time Controls

### Time Range

Limit decoding to a specific time window:
1. Click **Show time range**
2. Set **Start** and **End**
3. Only frames within this range are decoded

### Events

Mark a moment you want to come back to with **Add event at current position** (Cmd/Ctrl+D). Events belong to the capture and replace the old bookmarks.

## Selection Sets

Choose which frames are decoded with the frame picker in the top bar:
1. Create sets in [Discovery](discovery.md#selection-sets), or save one from the picker
2. Select a set in the frame picker
3. Frames left out of the selection move to the Filtered tab

This is useful for:
- Focusing on specific ECUs or message types
- Excluding noisy or irrelevant traffic
- Comparing behaviour of different frame groups

## Catalogue Requirements

The Decoder needs a catalogue. Catalogues define:
- Frame IDs to decode
- Signal positions within each frame
- Factor, offset, units and display precision for physical values
- Enumerated value mappings
- Multiplexing rules
- Checksums and header fields

See [Catalog Editor](catalog-editor.md) for creating and editing catalogues.

## Protocol Support

### CAN

- 11-bit and 29-bit frame IDs
- A frame ID mask and header fields for protocols such as J1939
- Big-endian and little-endian byte order
- CAN FD frames up to 64 bytes
- Modbus RTU tunnelled over a CAN ID, shown in the Modbus tab

### Serial

- SLIP, delimiter, Modbus RTU or raw framing, set in the catalogue
- Frame identification from header fields
- Checksum validation

### Modbus

- Registers defined per slave in the catalogue
- Polling from the catalogue's registers, with **Poll** and **Pause** in the top bar

## Tips

- Use the **Unmatched** tab to find messages that still need catalogue definitions
- Save frames to a catalogue from Discovery's **Save frames to decoder** before switching to the Decoder
- Create Selection Sets in Discovery for focused analysis
- Mark events during capture for quick navigation later
- Use **Load** for a large recorded source rather than playing it in real time

## Workflow Example

1. **Capture** - Use Discovery to capture frames from your CAN network
2. **Create Catalogue** - Define signals in the Catalog Editor (or use an existing one)
3. **Load Catalogue** - Select it in the Decoder
4. **Decode** - Watch signals update live or play back a capture
5. **Analyse** - Use the time range, filters and selection sets to focus on specific events

## See Also

- [Discovery](discovery.md) - Capture raw frames
- [Catalog Editor](catalog-editor.md) - Create and edit signal catalogues
- [Sessions](sessions.md) - Sources and shared sessions
