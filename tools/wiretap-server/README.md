# WireTAP Server

A GVRET-compatible TCP server that bridges Linux SocketCAN interfaces to TCP clients (like the WireTAP desktop app) and optionally ingests frames to PostgreSQL for historical analysis.

## Features

- **GVRET Protocol**: Compatible with SavvyCAN and WireTAP desktop applications
- **Multi-bus Support**: Bridge multiple CAN interfaces simultaneously
- **PostgreSQL Ingest**: Batch-insert frames for historical analysis
- **CAN FD Support**: Handle payloads up to 64 bytes
- **Kernel Timestamps**: Accurate frame timing via SO_TIMESTAMP
- **Direction Tracking**: Tag frames as RX or TX

## Hardware Requirements

- Raspberry Pi (any model with USB or SPI)
- CAN interface, such as:
  - **USB**: CANable, CANable Pro, Canable 2.0, PEAK PCAN-USB
  - **HAT/SPI**: Waveshare RS485 CAN HAT, PiCAN series, MCP2515-based boards

## Quick Start

### 1. Install Dependencies

```bash
# System packages
sudo apt update
sudo apt install -y python3 python3-pip can-utils

# Python packages
pip3 install -r requirements.txt
```

### 2. Configure the CAN Interface

#### USB Adapters (CANable, etc.)

USB CAN adapters typically use the `gs_usb` driver and appear as `can0`:

```bash
# Bring up the interface at 500 kbps
sudo ip link set can0 up type can bitrate 500000

# Verify it's up
ip -details link show can0
```

#### SPI/HAT Adapters (MCP2515-based)

For SPI-based adapters, enable the overlay in `/boot/firmware/config.txt`:

```ini
# MCP2515 CAN controller (adjust settings for your HAT)
dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25
dtoverlay=spi-bcm2835-overlay
```

Then reboot and bring up the interface:

```bash
sudo reboot
sudo ip link set can0 up type can bitrate 500000
```

#### CAN FD Interfaces

For CAN FD capable hardware:

```bash
sudo ip link set can0 up type can bitrate 500000 dbitrate 2000000 fd on
```

#### Verify with candump

Test your interface is receiving frames:

```bash
candump can0
```

You should see output like:
```
can0  7DF   [8]  02 01 00 00 00 00 00 00
can0  7E8   [8]  06 41 00 BE 3F A8 13 00
```

### 3. Configure wiretap-server

Copy the example config and edit as needed:

```bash
cp wiretap-server.toml my-config.toml
nano my-config.toml
```

Key settings:

```toml
[server]
iface = "can0"          # Your CAN interface(s), comma-separated for multiple
host = "0.0.0.0"        # Listen on all interfaces
port = 2323             # Use 23 for standard GVRET (requires root)
can_fd = false          # Set true for CAN FD interfaces

[postgres]
enable = false          # Set true to enable database logging
dsn = "postgresql://candor:password@localhost:5432/candor"
```

### 4. Run the Server

#### Ad-hoc (Manual Start)

```bash
# Basic usage
./wiretap-server.py -C my-config.toml

# With console echo for debugging
./wiretap-server.py -C my-config.toml --echo

# Override interface from command line
./wiretap-server.py -C my-config.toml --iface can0,can1

# Use environment variable for PostgreSQL DSN (avoids storing password in config)
export PG_DSN="postgresql://candor:secret@dbhost:5432/candor"
./wiretap-server.py -C my-config.toml
```

Press `Ctrl+C` to stop the server gracefully.

## Automatic Startup with systemd

### 1. Install the Service File

```bash
# Copy service file to systemd directory
sudo cp wiretap-server.service /etc/systemd/system/

# Edit the service file to match your setup
sudo nano /etc/systemd/system/wiretap-server.service
```

Update the paths and user in the service file:

```ini
[Unit]
Description=WireTAP GVRET Server
After=network.target

[Service]
Type=simple
User=pi
Group=pi
WorkingDirectory=/home/pi/wiretap-server
ExecStart=/usr/bin/python3 /home/pi/wiretap-server/wiretap-server.py -C /home/pi/wiretap-server/wiretap-server.toml
Restart=on-failure
RestartSec=5

# Optional: Set PostgreSQL DSN via environment
# Environment=PG_DSN=postgresql://candor:secret@localhost:5432/candor

[Install]
WantedBy=multi-user.target
```

### 2. Set Up the CAN Interface on Boot

There are two methods to bring up the CAN interface automatically on boot.

#### Method A: Using systemd (Recommended)

Copy the included service file:

```bash
sudo cp can-interface.service /etc/systemd/system/
sudo nano /etc/systemd/system/can-interface.service
```

Edit the bitrate and interface name as needed:

```ini
[Unit]
Description=CAN Interface Setup
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target sysinit.target
Wants=network-pre.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/sbin/ip link set can0 up type can bitrate 500000
ExecStop=/sbin/ip link set can0 down

[Install]
WantedBy=sysinit.target
```

For CAN FD interfaces, change the ExecStart line:

```ini
ExecStart=/sbin/ip link set can0 up type can bitrate 500000 dbitrate 2000000 fd on
```

#### Method B: Using /etc/network/interfaces

This method uses the traditional Debian network configuration:

```bash
sudo apt install -y can-utils
sudo nano /etc/network/interfaces.d/can0
```

Add the following:

```
auto can0
iface can0 inet manual
    pre-up /sbin/ip link set can0 type can bitrate 500000
    up /sbin/ip link set can0 up
    down /sbin/ip link set can0 down
```

For CAN FD:

```
auto can0
iface can0 inet manual
    pre-up /sbin/ip link set can0 type can bitrate 500000 dbitrate 2000000 fd on
    up /sbin/ip link set can0 up
    down /sbin/ip link set can0 down
```

Then enable the interface:

```bash
sudo ifup can0
```

### 3. Enable and Start Services

```bash
# Reload systemd to pick up new service files
sudo systemctl daemon-reload

# If using Method A (systemd) for CAN interface:
sudo systemctl enable can-interface.service
sudo systemctl start can-interface.service

# Enable and start wiretap-server
sudo systemctl enable wiretap-server.service
sudo systemctl start wiretap-server.service

# Check status
sudo systemctl status wiretap-server.service
```

After a reboot, both services will start automatically and wiretap-server will be ready to accept connections.

### 4. View Logs

```bash
# Live logs
sudo journalctl -u wiretap-server.service -f

# Recent logs
sudo journalctl -u wiretap-server.service -n 100
```

### 5. Manage the Service

```bash
# Stop the server
sudo systemctl stop wiretap-server.service

# Restart the server
sudo systemctl restart wiretap-server.service

# Disable auto-start on boot
sudo systemctl disable wiretap-server.service
```

## PostgreSQL Setup (Optional)

If you want to log frames to PostgreSQL:

### 1. Install PostgreSQL

```bash
# On the Raspberry Pi (local database)
sudo apt install -y postgresql postgresql-contrib

# Or connect to a remote PostgreSQL server
```

### 2. Create Database and User

```bash
sudo -u postgres psql
```

```sql
CREATE USER candor WITH PASSWORD 'your-secure-password';
CREATE DATABASE candor OWNER candor;
\q
```

### 3. Initialize the Schema

```bash
sudo -u postgres psql -d candor -f init_schema.sql
```

### 4. Configure the Server

Update your config file:

```toml
[postgres]
enable = true
dsn = "postgresql://candor:your-secure-password@localhost:5432/candor"
batch_size = 1000
flush_interval = 0.25
```

Or use an environment variable:

```bash
export PG_DSN="postgresql://candor:your-secure-password@localhost:5432/candor"
```

## Connecting from WireTAP Desktop

1. Open WireTAP desktop application
2. Go to **Settings** → **Data I/O**
3. Create a new IO Profile:
   - **Type**: GVRET TCP
   - **Host**: Your Raspberry Pi's IP address (e.g., `192.168.1.100`)
   - **Port**: `2323` (or `23` if using standard port)
4. Set as default read profile
5. Open **Discovery** or **Decoder** to start streaming

## Troubleshooting

### "No CAN interface found"

```bash
# Check if interface exists
ip link show type can

# Check kernel modules
lsmod | grep can

# Load modules manually if needed
sudo modprobe can
sudo modprobe can_raw
sudo modprobe gs_usb  # For USB adapters
```

### "Permission denied" on port 23

Port 23 requires root privileges. Either:
- Use a high port (e.g., `2323`) in your config
- Run as root: `sudo ./wiretap-server.py -C config.toml`
- Grant capability: `sudo setcap cap_net_bind_service=+ep /usr/bin/python3`

### "Connection refused" from WireTAP

```bash
# Check if server is running
sudo systemctl status wiretap-server.service

# Check if port is listening
sudo ss -tlnp | grep 2323

# Check firewall
sudo ufw status
sudo ufw allow 2323/tcp  # If needed
```

### High CPU usage

Reduce console output and increase batch sizes:

```toml
[server]
echo_console = false

[postgres]
batch_size = 2000
flush_interval = 0.5
```

### Frames not appearing in database

```bash
# Check PostgreSQL connection
psql -h localhost -U candor -d candor -c "SELECT COUNT(*) FROM can_frame;"

# Check server logs for errors
sudo journalctl -u wiretap-server.service -n 50
```

## Command Line Reference

```
usage: wiretap-server.py [-h] [-C CONFIG] [--iface IFACE] [--bus-offset N]
                        [--host HOST] [--port PORT] [--echo] [--colour]
                        [--default-dir DIR] [--can-fd] [--pg-enable]
                        [--pg-dsn DSN] [--pg-func FUNC] [--pg-batch-size N]
                        [--pg-flush-interval SEC] [--pg-queue-size N]
                        [--pg-dir DIR] [--log-level LEVEL]
                        [--stats-interval SEC]

Options:
  -C, --config CONFIG     Path to TOML config file
  --iface IFACE           CAN interface(s), comma-separated
  --bus-offset N          GVRET bus number offset
  --host HOST             TCP listen address
  --port PORT             TCP listen port
  --echo                  Echo frames to console
  --colour                Colorize ASCII bytes in console output
  --can-fd                Enable CAN FD support
  --pg-enable             Enable PostgreSQL ingest
  --pg-dsn DSN            PostgreSQL connection string
  --log-level LEVEL       Log level (DEBUG, INFO, WARNING, ERROR)
```

## License

See the main WireTAP repository for license information.
