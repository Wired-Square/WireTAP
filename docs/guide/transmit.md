# Transmit

The Transmit panel allows you to send CAN frames or serial bytes to your network, either as single transmissions or repeating messages, and shows the replays started from Discovery.

<img width="941" height="689" alt="transmit-screenshot" src="https://github.com/user-attachments/assets/365b308c-62eb-43fe-ab56-4d49962a01e0" />

## Overview

Use Transmit to:
- Send test frames during development
- Simulate ECU behaviour
- Trigger specific vehicle functions
- Test your decoding setup with known data

## Interface Tabs

### Frame Tab

Build and send CAN frames:

| Field | Description |
|-------|-------------|
| **Frame ID** | 11-bit (standard) or 29-bit (extended) identifier, in hex |
| **DLC** | Payload length in bytes (0-8, or up to 64 for CAN FD) |
| **Bus** | Output bus, on a device or session with more than one |
| **Flags** | **Extended (29-bit)**, **CAN FD**, **BRS** (bit-rate switch) and **RTR** (remote request, no data) |
| **Data Bytes** | Payload bytes in hex, one box per byte |

A preview line shows the frame as it will be sent. Click **Send Once** to transmit the frame once, or **Reset** to clear the editor. CAN FD is offered only where the interface supports it (not on GVRET, which sends classic CAN only).

### Bytes Tab (Serial)

On a serial session the first tab is **Bytes**, for sending raw serial data:

| Field | Description |
|-------|-------------|
| **Hex Bytes** | Payload in hex (`AA BB CC`; spaces, commas or dashes between bytes) |
| **Framing Mode** | **Raw (No Framing)**, **SLIP**, or **Delimiter** |
| **Delimiter (hex)** | Bytes appended in Delimiter mode (default `0D 0A`, CRLF) |

A preview shows the byte count and an ASCII rendering. Click **Send** to transmit now.

### Queue Tab

Manage repeating transmissions:

| Column | Description |
|--------|-------------|
| **Play/Stop** | Start or stop the row's repeat (or its group's) |
| **Bus** | The session and bus the row sends on |
| **Type** | CAN or Serial |
| **Frame / Data** | Frame ID, length and data preview, with flags |
| **Interval** | Repeat interval in milliseconds (editable) |
| **Group** | Optional group name; rows in the same group repeat together |
| **Actions** | Enable or disable the row, or remove it from the queue |

A row started by an MCP agent is marked **Agent**.

### Replay Tab

A log of replays started from Discovery (**Replay frames**), with each start, pass, completion, stop or error. A running replay can be stopped, and a finished one restarted.

### History Tab

View previously sent frames for the panel's session:
- Timestamp of transmission
- Frame ID and data
- Success/failure status, including sends refused before they reached the device
- **Live** follows the newest frames; click it to browse older pages
- Export the history as CSV, or clear it

## Sending Frames

### Single Transmission

1. Enter the frame ID and data in the Frame tab
2. Click **Send Once**
3. The frame is transmitted immediately
4. Check History tab to confirm

### Repeated Transmission

1. Build your frame in the Frame tab
2. Click **Add to Queue**
3. In the Queue tab, set the row's **Interval** (1000 ms by default)
4. Click the row's play button to start transmitting; click it again to stop

A repeat stops on its own if the device refuses a send for good, and the row shows the error.

## Session Selection

Choose which IO session to use for transmission with the session button in the top bar, which opens the same **Data Source** picker as the other apps:
- Join a session another app already has open, or connect to a device
- Only transmit-capable devices can send (for example slcan, GVRET, SocketCAN, gs_usb and serial ports); an slcan device in silent mode cannot
- Queue rows stay with the session they were queued on, so rows from different sessions can repeat to different buses at once

The dot on the session button shows the session's state (green when running). Badges beside it show **FD** when the session can send CAN FD, **Multi-Bus** when it has more than one bus, and **Multi-Source** for a session with several devices. A gs_usb bus in trouble shows a **No ACK**, **Error passive** or **Bus off** chip.

## From Discovery

Discovery's frame menu can fill Transmit for you:
- **Send to Transmit** opens the frame in the Frame tab, flags included
- **Add to Transmit queue** queues many frame IDs at once, with a frame ID range, output bus, repeat interval and optional group
- **Replay frames** replays a range of the capture at its original timing, at a chosen speed and optionally looping, on each frame's own bus or one fixed bus

These need Transmit to be connected to a session first.

## Queue Management

### Start/Stop

Click a row's play button to start its repeat, and the stop button to end it. A row that is repeating can't be edited.

### Groups

Give rows the same **Group** name to send them as a sequence: the group's play button, on its first enabled row, sends every enabled row in queue order, back to back, then waits the interval.

### Enable/Disable and Remove

Untick a row to leave it out of repeats without removing it, or remove it from the queue entirely.

### Bulk Actions

- **Stop All** - Stop all running repeats
- **Clear** - Remove all queue entries

## Safety Considerations

**Warning:** Transmitting frames to a live CAN network can affect vehicle or equipment operation. Always:

- Test on isolated networks first
- Know what frames you're sending and their effects
- Have a way to disconnect quickly if needed
- Never transmit to safety-critical systems without proper precautions

## Tips

- Use Discovery's **Send to Transmit** to resend a frame you captured
- Set up common test frames in the Queue for repeated use during development
- Test your decoder by transmitting known values and verifying the decode

## Example: Testing a Decoder

1. Create a signal catalog with a frame definition
2. Load the catalog in the Decoder
3. In Transmit, enter the frame's ID and set its data bytes to known test values
4. Send the frame
5. Verify the Decoder shows the expected values

## See Also

- [Discovery](discovery.md) - Capture frames from your network
- [Decoder](decoder.md) - Verify transmitted frames are decoded correctly
- [Supported Hardware](supported-hardware.md) - Hardware that supports transmission
