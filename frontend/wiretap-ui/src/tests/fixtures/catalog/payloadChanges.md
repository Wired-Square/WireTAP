# CAN Bus Payload Analysis Report

## Overview

| Metric | Value |
|--------|-------|
| Total Frames | 12,345 |
| Unique Frame IDs | 11 |
| Mirror Groups | 2 |
| Identical Payload Frames | 1 |
| Variable Length Frames | 1 |
| Multiplexed Frames | 3 |
| Burst Pattern Frames | 2 |

## Mirror Frame Groups

Mirror frames are different CAN IDs that transmit identical payloads changing in unison.
This often indicates redundant/backup signals or re-transmitted data.

### Group 1

- **Frame IDs**: 0x100, 0x18FF0010
- **Match Rate**: 98%
- **Paired Samples**: 45
- **Sample Payload**: `00 1F AB FF`

### Group 2

- **Frame IDs**: 1/0x03, 2/0x03
- **Match Rate**: 100%
- **Paired Samples**: 3
- **Sample Payload**: `01`

## Frame Analysis Details

### Frame 0x100

| Property | Value |
|----------|-------|
| Samples | 0 |
| Identical | No |
| Multiplexed | No |
| Burst Pattern | No |

**Analysis Notes:**

- No frames to analyse

### Frame 0x101

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Length Range | 6-8 bytes |
| Multiplexed | No |
| Burst Pattern | Yes |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 0 | static | Value: 0x1F |
| 1 | counter | Step: 1 |
| 2 | counter | Looping 0–9 (mod 10), step=1 |
| 3 | sensor | Trend: decreasing |
| 4 | value | 20 unique values |
| 5 | value | 20 unique values |
| 6 | value | 20 unique values |
| 7 | unknown |  |

**Multi-Byte Patterns:**

- **byte[4:5]**: `counter16` (little endian)
- **byte[6:7]**: `text` - text: "OK"

**Analysis Notes:**

- Little-endian (inferred from 1 multi-byte pattern(s))
- Varying length: 6–8 bytes
- Burst frame: analysing stable payload portion only
- Static bytes: byte[0]=0x1F
- Counter at byte[1]: incrementing, step=1 (rollover detected)
- Looping counter at byte[2]: incrementing, step=1, range 0–9 (mod 10)
- Sensor at byte[3]: ↓ range 10–90 (76% trend)
- 16-bit counter at byte[4:5], little endian
- Text at byte[6:7] "OK"

### Frame 0x00000102

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | No |
| Burst Pattern | No |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 0 | counter | Step: 2 |
| 1 | sensor | Trend: mixed |
| 2 | sensor | Trend: increasing |
| 3 | counter | Looping 1–3 (mod 0), step=3 |

**Analysis Notes:**

- Counter at byte[0]: decrementing, step=2
- Looping counter at byte[3]: incrementing, step=3, range 1–3 (mod 0)
- Sensor at byte[1]: ↕ range 3–200
- Sensor at byte[2]: ↑ range 0–15 (50% trend)

### Frame 0x103

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | No |
| Burst Pattern | No |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 0 | static | Value: 0x00 |
| 1 | counter | Step: 1 |
| 2 | sensor | Trend: increasing |
| 3 | value | 20 unique values |
| 4 | value | 20 unique values |

**Multi-Byte Patterns:**

- **byte[0:1]**: `counter16` (big endian) - rollover detected
- **byte[2:3]**: `sensor16`
- **byte[4:7]**: `text`

**Analysis Notes:**

- Static bytes: byte[0]=0x00
- 16-bit counter at byte[0:1], big endian (rollover detected)
- 16-bit sensor at byte[2:3]
- Text at byte[4:7]

### Frame 0x104

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | No |
| Burst Pattern | No |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 0 | value | 20 unique values |
| 1 | value | 20 unique values |
| 2 | unknown |  |

**Analysis Notes:**

- 2 byte(s) with varying values detected

### Frame 0x105

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | No |
| Burst Pattern | No |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 0 | value | 20 unique values |
| 1 | value | 20 unique values |
| 2 | value | 20 unique values |
| 3 | value | 20 unique values |
| 4 | value | 20 unique values |
| 5 | value | 20 unique values |

**Multi-Byte Patterns:**

- **byte[0:1]**: `sensor16` (big endian) - rollover detected - range: 100 to 700
- **byte[2:5]**: `sensor32` (little endian) - rollover detected - range: 5 to 70000

**Analysis Notes:**

- Mixed endianness (inferred from 2 multi-byte pattern(s))
- 16-bit sensor at byte[0:1], big endian, range 100–700 (rollover correlation detected)
- 32-bit sensor at byte[2:5], little endian, range 5–70000 (slow-changing upper bytes) (rollover correlation detected)

### Frame 0x106

| Property | Value |
|----------|-------|
| Samples | 3 |
| Identical | Yes |
| Multiplexed | No |
| Burst Pattern | No |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 0 | static | Value: 0x01 |
| 1 | static | Value: 0xAB |

**Analysis Notes:**

- Identical payload across all 3 samples: 01 AB
- Static bytes: byte[0]=0x01, byte[1]=0xAB

### Frame 0x107

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | No |
| Burst Pattern | No |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 0 | value | 20 unique values |

**Analysis Notes:**

- Big-endian (inferred from 0 multi-byte pattern(s))
- 1 byte(s) with varying values detected

### Frame 0x108

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | Yes |
| Burst Pattern | No |

**Byte Roles:**

| Byte | Role | Details |
|------|------|---------|
| 1 | counter | Step: 1 |
| 2 | value | 20 unique values |

**Multiplexing:**

- Selector: byte[0]
- Values: 0x0, 0x1, 0x2

**Per-Case Analysis:**

#### Case 0x0 (10 samples)

- Static: byte[2]=0x11
- Counter byte[1]: dec, step=1 +rollover
- Loop counter byte[3]: inc, step=1, 0–14 (mod 15)
- Sensor byte[4]: ↓ range 4–44

#### Case 0x1 (10 samples)

- byte[1:2]: sensor16 (big)
- byte[3:4]: counter16 (big)
- byte[5:7]: text
- 16b sensor byte[1:2] big 3–900 +slow-upper +correlated
- 16b counter byte[3:4] big +rollover
- Text byte[5:7] "abc"

#### Case 0x2 (10 samples)

- byte[1:4]: sensor32 (little)
- 32b sensor byte[1:4] little

**Analysis Notes:**

- Mixed endianness (inferred from 3 multi-byte pattern(s))
- Multiplexed frame: byte[0], cases: 0, 1, 2
- Case 0: 2 counter, 1 static
- Case 1: 1 counter, 0 static

### Frame 0x109

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | Yes |
| Burst Pattern | No |

**Multiplexing:**

- Selector: byte[0]
- Values: 0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6

**Per-Case Analysis:**

#### Case 0x0 (4 samples)

- Static: byte[1]=0x00

#### Case 0x1 (4 samples)

- Static: byte[1]=0x01

#### Case 0x2 (4 samples)

- Static: byte[1]=0x02

#### Case 0x3 (4 samples)

- Static: byte[1]=0x03

#### Case 0x4 (4 samples)

- Static: byte[1]=0x04

#### Case 0x5 (4 samples)

- Static: byte[1]=0x05

#### Case 0x6 (4 samples)

- Static: byte[1]=0x06

**Analysis Notes:**

- Multiplexed frame: byte[0], 7 cases (0-6)

### Frame 0x10A

| Property | Value |
|----------|-------|
| Samples | 20 |
| Identical | No |
| Multiplexed | Yes |
| Burst Pattern | Yes |

**Multiplexing:**

- Selector: byte[0:1]
- Values: 0x101, 0x102
- Type: 2-byte selector

**Per-Case Analysis:**

#### Case 0x101 (5 samples)

- Counter byte[2]: inc, step=1

#### Case 0x102 (5 samples)


**Analysis Notes:**

- Burst frame with mux: analysing stable payload portion only
- Multiplexed frame: byte[0:1], 2 cases
- Case 1:1: 1 counter, 0 static

---
*Generated by WireTAP*