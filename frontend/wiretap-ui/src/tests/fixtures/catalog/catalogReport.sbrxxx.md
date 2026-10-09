# CAN Catalog Report — SBRXXX

## Overview

| Property | Value |
|----------|-------|
| Version | 11 |
| Default Endianness | little |
| Frames | 76 |
| Mux Frames | 7 |
| Enums | 13 |
| Signals | 162 |

### Signal Confidence

- **High**: 117
- **Medium**: 12
- **Low**: 17
- **None**: 16

## Frames

### 0x000

*Length: 8*

### 0x001

*Length: 8*

### 0x002

*Length: 8*

### 0x003

*Length: 8*

### 0x004

*Length: 8*

### 0x005

*Length: 8*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 8/8 | `Status_Battery_End_Stop` | - |  | no | LE | high | Carried only on the 0x0NN copy — byte 1 is 0 on the 0x505/0x705 copies, hence the local declaration. Bits 0-1 are a state code and bit 4 an independent maintenance flag; they combine, giving 16 and 17. Share of 28.7 M samples: 0 = 72.0 %, 1 = 26.6 %, 2 = 1.16 %, 3 = 0.18 %, 16 = 0.066 %, 17 = 0.001 %. Value 1 coincides with SoC = 100 % and Info_Battery_Max_Charge_Current at 0x701 reading exactly 0 for the whole window. Value 2 tracks the SoC floor but does not stop discharge — Info_Battery_Max_Discharge_Current held 261-298 dA through a 14 h value-2 window. Value 3 is not a both-ends-reached condition: the pack is online but passing no current while still advertising 30 A in both directions and reporting Run, making it the only indication that those limits are not live. Seen during BMS restart (35-47 s, with 705_End_Stop reading 2 over the same window) and during commanded maintenance (no 0x705 counterpart, lasting up to ~9 h). |

### 0x006

*Length: 8*

### 0x007

*Length: 8*

### 0x008

*Length: 8*

### 0x009

*Length: 8*

### 0x00A

*Length: 8*

### 0x00B

*Length: 8*

### 0x00D

*Length: 8*

### 0x00E

*Length: 8*

### 0x013

*Length: 8*

### 0x014

*Length: 8*

### 0x015

*Length: 8*

### 0x016

*Length: 8*

### 0x017

*Length: 8*

### 0x018

*Length: 8*

### 0x019

*Length: 8*

### 0x01A

*Length: 8*

### 0x01B

*Length: 8*

### 0x01C

*Length: 8*

### 0x01D

*Length: 8*

### 0x01E

*Length: 8*

### 0x100

*Length: 8 | Transmitter: Inverter*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `100` | - |  | no | LE | none |  |

### 0x101

*Length: 8 | Transmitter: Inverter*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/32 | `Status_Inverter_Timestamp` | - |  | no | LE | high | Once per hour when battery connected |

### 0x102

*Length: 8 | Transmitter: Inverter*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `102` | - |  | no | LE | none | NOBATT |

### 0x103

*Length: 8 | Transmitter: Inverter*

#### Mux @ bit 0/8 (mux_259_0_8)

**Case 0x0:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Inverter_SN_1` | - |  | medium |

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Inverter_SN_2` | - |  | medium |

### 0x104

*Length: 8 | Transmitter: Inverter*

#### Mux @ bit 0/8 (mux_260_0_8)

**Case 0x0:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Inverter_Manufacturer_1` | - |  | medium |

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Inverter_Manufacturer_2` | - |  | medium |

### 0x105

*Length: 8 | Transmitter: Inverter*

#### Mux @ bit 0/8 (mux_261_0_8)

**Case 0x0:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Inverter_Model_1` | - |  | medium |

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Inverter_Model_2` | - |  | none |

### 0x106

*Length: 8 | Transmitter: Inverter*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `106_Unknown_1` | - |  | no | LE | none |  |
| 16/16 | `106_Unknown_2` | - |  | no | LE | low | Constant 1000 across every sampled maintenance session. |
| 32/16 | `106_Maintenance_Param` | - |  | no | LE | low | Moves with Cmd_Maintenance_Mode — 270 at entry, revised to 210 mid-session, 0 while the command is clear — but 270 also occurs outside maintenance (byte 4 = 14 in 7.1 % of all samples), so it is not a dedicated maintenance field. Not the target SoC: a session that ran with 210 settled at 23.56-23.93 %, which 210 does not encode under any obvious scaling. Units unresolved; a current or power limit would fit the magnitude. |
| 48/8 | `Cmd_Maintenance_Mode` | - |  | no | LE | high | Inverter to battery, and what puts the pack into maintenance. Across five observed sessions the battery raised bit 4 of Status_Battery_End_Stop at 0x005 within ~2.3 s of every rising edge and cleared it within ~0.8 s of every falling edge. Frame 0x012 is transmitted only while this is set, at ~0.95 Hz. |
| 56/8 | `106_Padding` | - |  | no | LE | medium |  |

### 0x108

*Length: 8 | Transmitter: Inverter*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `108` | - |  | no | LE | none |  |

### 0x109

*Length: 8 | Transmitter: Inverter*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `109_Marker` | - |  | no | LE | high | Constant 0xAA in every sample. Frame marker / protocol tag, not data. |
| 8/16 | `Status_PV_Power` | - | W | no | LE | high | The inverter's total DC (PV) input — matches the "Total DC power" it reports over Modbus (3882 W vs 3935 W decoded seconds later). Not battery power: same battery current gives different values here. Zero all night; peak 7423 W across the archive. |
| 24/40 | `109_Padding` | - |  | no | LE | high | Always zero across every sampled window. |

### 0x191

*Length: 8 | Transmitter: Inverter*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `191` | - |  | no | LE | none |  |

### 0x1E0

*Length: 8 | Transmitter: Inverter*

### 0x400

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `400_Padding` | - |  | no | LE | none |  |
| 8/16 | `Status_Battery_Actual_SoC` | x0.01 + 0 | % | no | LE | high |  |
| 24/40 | `400_Unknown` | - |  | no | LE | none |  |

### 0x401

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `401_Padding` | - |  | no | LE | high |  |

### 0x402

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `402_Unknown` | - |  | no | LE | high | Confirmed completely static on a real SBR224: 3,539,015 frames over ~41 days with zero byte changes, payload always 00 00 55 00 00 00 00 00. High confidence it is a constant; the meaning of byte 2 = 0x55 is still unknown. |

### 0x500

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `500_Unknown_0` | - |  | no | LE | none |  |
| 8/16 | `500_Unknown_1` | - |  | no | LE | none |  |
| 24/32 | `500_Unknown_2` | - |  | no | LE | none |  |
| 56/8 | `Status_Battery_SoC_Int` | - | % | no | LE | high |  |

### 0x501

*Length: 8*

### 0x502

*Length: 8*

### 0x503

*Length: 8*

### 0x504

*Length: 8*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 16/16 | `Status_Battery_Current_Inverted` | x0.1 + 0 | A | yes | LE | high | This is the opposite sign to the signal at 0x704 |

### 0x505

*Length: 8*

### 0x506

*Length: 8*

### 0x512

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `512_Padding` | - |  | no | LE | high |  |

### 0x700

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `700_Padding` | - |  | no | LE | high |  |

### 0x701

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Info_Battery_Max_Voltage` | x0.1 + 0 | V | no | LE | high |  |
| 16/16 | `Info_Battery_Min_Voltage` | x0.1 + 0 | V | no | LE | high |  |
| 32/16 | `Info_Battery_Max_Charge_Current` | x0.1 + 0 | A | no | LE | high |  |
| 48/16 | `Info_Battery_Max_Dischg_Current` | x0.1 + 0 | A | no | LE | high |  |

### 0x702

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Status_Battery_Reported_SoC` | x0.01 + 0 | % | no | LE | high |  |
| 16/16 | `Status_Battery_SoH` | x0.01 + 0 | % | no | LE | high |  |
| 32/16 | `Status_Battery_Remaining_Energy` | - | Wh | no | LE | high |  |
| 48/16 | `Status_Battery_Max_Energy` | - | Wh | no | LE | high |  |

### 0x703

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/32 | `Status_Battery_Energy_Charged` | - | Wh | no | LE | high |  |
| 32/32 | `Status_Battery_Energy_Discharged` | - | Wh | no | LE | high |  |

### 0x704

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Status_Battery_Voltage` | x0.1 + 0 | V | no | LE | high |  |
| 16/16 | `Status_Battery_Current` | x0.1 + 0 | A | yes | LE | high |  |
| 32/16 | `Status_Battery_Voltage_Alt_704` | x0.1 + 0 | V | no | LE | medium | A second voltage reading alongside Status_Battery_Voltage in this frame; relationship to the primary reading unconfirmed. Named by frame id to keep it distinct from the equivalent signal at 0x705. |
| 48/16 | `Status_Battery_Temperature` | x0.1 + 0 | °C | yes | LE | high |  |

### 0x705

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `Info_Battery_Operation` | - |  | no | LE | high |  |
| 8/8 | `705_End_Stop` | - |  | no | LE | low | The same byte as Status_Battery_End_Stop on the 0x005 copy, but nearly inert here: 0 across all 28.3 M sampled frames except 2 for 36-47 s during each of four BMS restarts, 156 samples in total. Never 1, so the charge end stop is not reported on this copy. Discriminates why 0x005 reads 3 — both abnormal together is a BMS restart, 0x005 alone is maintenance. Previously named 705_Always_0, which was accurate for this frame but wrong for the 0x005 mirror. |
| 16/8 | `705_Always_1` | - |  | no | LE | low |  |
| 24/16 | `Info_Battery_Type` | - |  | no | LE | high |  |
| 40/16 | `Status_Battery_Voltage_Alt_705` | x0.1 + 0 | V | no | LE | medium | A voltage reading carried in the battery-identity frame; relationship to Status_Battery_Voltage at 0x704 unconfirmed. Named by frame id to keep it distinct from the equivalent signal at 0x704. |
| 56/8 | `705_Padding` | - |  | no | LE | medium |  |

### 0x706

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Overview_Cell_Max_Temp` | x0.1 + 0 | °C | yes | LE | high |  |
| 16/16 | `Overview_Cell_Min_Temp` | x0.1 + 0 | °C | yes | LE | high |  |
| 32/16 | `Overview_Cell_Max_Voltage` | x0.001 + 0 | V | no | LE | high |  |
| 48/16 | `Overview_Cell_Min_Voltage` | x0.001 + 0 | V | no | LE | high |  |

### 0x707

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `Info_BMS_Firmware_Patch` | - |  | no | LE | high |  |
| 8/16 | `707_All_Zero` | - |  | no | LE | none |  |
| 24/8 | `Info_BMS_Firmware_Minor` | - |  | no | LE | high |  |
| 32/16 | `Info_Battery_Nameplate_Capacity` | - | Wh | no | LE | high |  |
| 48/16 | `Info_Battery_Module_Count` | - |  | no | LE | high |  |

### 0x708

*Length: 8 | Transmitter: BMS*

#### Mux @ bit 0/8 (mux_1800_0_8)

**Case 0x0:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Battery_SN_1` | - |  | high |

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/48 | `Info_Battery_SN_2` | - |  | high |

### 0x709

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `709_Padding` | - |  | no | LE | none |  |

### 0x70A

*Length: 8 | Transmitter: BMS*

#### Mux @ bit 0/8 (mux_1802_0_8)

**Case 0x0:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Battery_Manufacturer` | - |  | high |

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `Info_Battery_Model_Short` | - |  | medium |

### 0x70B

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `Info_Battery_Model` | - |  | no | LE | medium |  |

### 0x70D

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `70d_Unknown_Permission_3_10701__` | - |  | no | LE | none |  |

### 0x70E

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/64 | `70E_Unknown_Permission_3_10705__` | - |  | no | LE | none |  |

### 0x70F

*Length: 8 | Transmitter: BMS*

#### Mux @ bit 0/8 (mux_1807_0_8)

**Case 0x0:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/16 | `70F_Mux0_Const` | - |  | low |
| 32/16 | `Info_Battery_Max_Power` | - | W | high |
| 48/16 | `Info_Battery_Max_Power_2` | - | W | high |

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/56 | `70F_Mux1_Padding` | - |  | low |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/16 | `70F_Unknown_Mux_2_1` | - |  | low |
| 32/16 | `70F_Mux2_Padding` | - |  | low |
| 48/16 | `70F_Unknown_Mux_2_3` | - |  | none |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/16 | `70F_Unknown_Mux_3_1` | - |  | low |
| 32/16 | `70F_Mux3_Padding` | - |  | low |
| 48/16 | `70F_Unknown_Mux_3_3` | x0.01 + 0 | % | low |

**Case 0x4:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 8/8 | `70F_Mux4_Padding_0` | - |  | low |
| 16/16 | `70F_Mux4_Charge_Value` | - |  | low |
| 32/24 | `70F_Mux4_Padding_1` | - |  | low |
| 56/8 | `Status_Charge_State` | - |  | high |

**Case 0x5:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/16 | `Status_Module_1_SoC` | x0.01 + 0 | % | high |
| 32/16 | `Status_Module_2_SoC` | x0.01 + 0 | % | high |
| 48/16 | `Status_Module_3_SoC` | x0.01 + 0 | % | high |

**Case 0x6:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/16 | `Status_Module_4_SoC` | x0.01 + 0 | % | high |
| 32/16 | `Status_Module_5_SoC` | x0.01 + 0 | % | high |
| 48/16 | `Status_Module_6_SoC` | x0.01 + 0 | % | high |

**Case 0x7:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/16 | `Status_Module_7_SoC` | x0.01 + 0 | % | high |
| 32/16 | `Status_Module_8_SoC` | x0.01 + 0 | % | medium |
| 48/16 | `70F_Mux7_Padding` | - |  | low |

### 0x713

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `Status_Pos_Cell_Min_Temp` | - | Cell # | no | LE | high |  |
| 8/8 | `Status_Pos_Module_Min_Temp` | - | Module # | no | LE | high |  |
| 16/16 | `Status_Cell_Min_Temp` | x0.1 + 0 | °C | yes | LE | high |  |
| 32/8 | `Status_Pos_Cell_Max_Temp` | - | Cell # | no | LE | high |  |
| 40/8 | `Status_Pos_Module_Max_Temp` | - | Module # | no | LE | high |  |
| 48/16 | `Status_Cell_Max_Temp` | x0.1 + 0 | °C | yes | LE | high |  |

### 0x714

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `Status_Pos_Cell_Max_Voltage` | - | Cell # | no | LE | high |  |
| 8/8 | `Status_Pos_Module_Max_Voltage` | - | Module # | no | LE | high |  |
| 16/16 | `Status_Cell_Max_Voltage_HP` | x0.0001 + 0 | V | no | LE | high |  |
| 32/8 | `Status_Pos_Cell_Min_Voltage` | - | Cell # | no | LE | high |  |
| 40/8 | `Status_Pos_Module_Min_Voltage` | - | Module # | no | LE | high |  |
| 48/16 | `Status_Cell_Min_Voltage_HP` | x0.0001 + 0 | V | no | LE | high |  |

### 0x715

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Status_Module_1_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 16/16 | `Status_Module_1_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 32/16 | `Status_Module_2_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 48/16 | `Status_Module_2_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |

### 0x716

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Status_Module_3_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 16/16 | `Status_Module_3_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 32/16 | `Status_Module_4_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 48/16 | `Status_Module_4_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |

### 0x717

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Status_Module_5_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 16/16 | `Status_Module_5_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 32/16 | `Status_Module_6_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 48/16 | `Status_Module_6_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |

### 0x718

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Status_Module_7_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 16/16 | `Status_Module_7_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 32/16 | `Status_Module_8_Min_Voltage` | x0.0001 + 0 | V | no | LE | high |  |
| 48/16 | `Status_Module_8_Max_Voltage` | x0.0001 + 0 | V | no | LE | high |  |

### 0x719

*Length: 8 | Transmitter: BMS*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/16 | `Status_3_10789__` | - |  | no | LE | low |  |
| 16/16 | `Status_Module_Fault_3_10790__` | - |  | no | LE | low |  |

### 0x71A

*Length: 8 | Transmitter: BMS | Interval: 60000ms*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/8 | `Info_Module_1_Cell_Type` | - |  | no | LE | high |  |
| 8/8 | `Info_Module_2_Cell_Type` | - |  | no | LE | high |  |
| 16/8 | `Info_Module_3_Cell_Type` | - |  | no | LE | high |  |
| 24/8 | `Info_Module_4_Cell_Type` | - |  | no | LE | high |  |
| 32/8 | `Info_Module_5_Cell_Type` | - |  | no | LE | high |  |
| 40/8 | `Info_Module_6_Cell_Type` | - |  | no | LE | high |  |
| 48/8 | `Info_Module_7_Cell_Type` | - |  | no | LE | high |  |
| 56/8 | `Info_Module_8_Cell_Type` | - |  | no | LE | high |  |

### 0x71B

*Length: 8 | Transmitter: BMS | Interval: 60000ms*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/32 | `Info_Module_1_Production_Date` | - |  | no | LE | high |  |
| 32/32 | `Info_Module_2_Production_Date` | - |  | no | LE | high |  |

### 0x71C

*Length: 8 | Transmitter: BMS | Interval: 60000ms*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/32 | `Info_Module_3_Production_Date` | - |  | no | LE | high |  |
| 32/32 | `Info_Module_4_Production_Date` | - |  | no | LE | high |  |

### 0x71D

*Length: 8 | Transmitter: BMS | Interval: 60000ms*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/32 | `Info_Module_5_Production_Date` | - |  | no | LE | high |  |
| 32/32 | `Info_Module_6_Production_Date` | - |  | no | LE | high |  |

### 0x71E

*Length: 8 | Transmitter: BMS | Interval: 60000ms*

#### Signals

| Bit Range | Signal | Scale | Unit | Signed | Endian | Confidence | Notes |
|-----------|--------|-------|------|--------|--------|------------|-------|
| 0/32 | `Info_Module_7_Production_Date` | - |  | no | LE | high |  |
| 32/32 | `Info_Module_8_Production_Date` | - |  | no | LE | high |  |

### 0x71F

*Length: 8 | Transmitter: BMS | Interval: 60000ms*

#### Mux @ bit 0/8 (mux_1823_0_8)

**Case 0x1:**

##### Mux @ bit 8/8 (mux_1823_1_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_1_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_1_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_1_SN_3` | - |  | high |

**Case 0x2:**

##### Mux @ bit 8/8 (mux_1823_2_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_2_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_2_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_2_SN_3` | - |  | high |

**Case 0x3:**

##### Mux @ bit 8/8 (mux_1823_3_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_3_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_3_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_3_SN_3` | - |  | high |

**Case 0x4:**

##### Mux @ bit 8/8 (mux_1823_4_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_4_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_4_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_4_SN_3` | - |  | high |

**Case 0x5:**

##### Mux @ bit 8/8 (mux_1823_5_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_5_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_5_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_5_SN_3` | - |  | high |

**Case 0x6:**

##### Mux @ bit 8/8 (mux_1823_6_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_6_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_6_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_6_SN_3` | - |  | high |

**Case 0x7:**

##### Mux @ bit 8/8 (mux_1823_7_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_7_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_7_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_7_SN_3` | - |  | high |

**Case 0x8:**

##### Mux @ bit 8/8 (mux_1823_8_8_8)

**Case 0x1:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_8_SN_1` | - |  | high |

**Case 0x2:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_8_SN_2` | - |  | high |

**Case 0x3:**

| Bit Range | Signal | Scale | Unit | Confidence |
|-----------|--------|-------|------|------------|
| 16/48 | `Info_Module_8_SN_3` | - |  | high |

---
*Generated by WireTAP*