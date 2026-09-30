use std::{fmt, str::FromStr, time::Duration};

use clap::Args;
use wiretap_io::can::{gvret, slcan, CanFrame, CanOptions, CanTask, CanWriter, DeviceInfo};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use wiretap_io::can::{
    pcan::{self, PcanDevice, PcanOptions},
    CanError,
};
use wiretap_io::serial::{LineSettings, Parity};

const DEFAULT_BITRATE: u32 = 500_000;
const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(3);
/// USB CDC adapters ignore the line rate; a UART-attached one needs it.
const SLCAN_LINE: LineSettings = LineSettings {
    baud: 115_200,
    data_bits: 8,
    parity: Parity::None,
    stop_bits: 1,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Interface {
    GsUsb { device: UsbSelector, channel: u8 },
    Pcan { device: UsbSelector, channel: u8 },
    Slcan { port: String },
    SocketCan { name: String },
    Gvret { endpoint: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UsbSelector {
    Serial(String),
    BusAddress(u8, u8),
}

impl fmt::Display for UsbSelector {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serial(serial) => f.write_str(serial),
            Self::BusAddress(bus, address) => write!(f, "{bus}:{address}"),
        }
    }
}

/// `<serial>[/<channel>]` or `<bus:addr>[/<channel>]`.
fn usb_selector(rest: &str, usage: impl Fn() -> String) -> Result<(UsbSelector, u8), String> {
    let (selector, channel) = match rest.split_once('/') {
        Some((selector, channel)) => (
            selector,
            channel
                .parse()
                .map_err(|_| format!("'{channel}' is not a channel number"))?,
        ),
        None => (rest, 0),
    };
    let device = match selector.split_once(':') {
        Some((bus, address)) => match (bus.parse(), address.parse()) {
            (Ok(bus), Ok(address)) => UsbSelector::BusAddress(bus, address),
            _ => return Err(format!("'{selector}' is not a USB bus:address")),
        },
        None if selector.is_empty() => return Err(usage()),
        None => UsbSelector::Serial(selector.to_owned()),
    };
    Ok((device, channel))
}

impl FromStr for Interface {
    type Err = String;

    fn from_str(s: &str) -> Result<Self, String> {
        let usage = || {
            format!(
                "'{s}' is not an interface: use gsusb:<serial>[/<channel>], gsusb:<bus:addr>[/<channel>], \
                 pcan:<serial>[/<channel>], pcan:<bus:addr>[/<channel>], \
                 slcan:<port>, socketcan:<if> or gvret:<host:port>"
            )
        };
        let (kind, rest) = s.split_once(':').ok_or_else(usage)?;
        if rest.is_empty() {
            return Err(usage());
        }
        match kind {
            "gsusb" | "pcan" => {
                let (device, channel) = usb_selector(rest, usage)?;
                Ok(if kind == "gsusb" {
                    Self::GsUsb { device, channel }
                } else {
                    Self::Pcan { device, channel }
                })
            }
            "slcan" => Ok(Self::Slcan {
                port: rest.to_owned(),
            }),
            "socketcan" => Ok(Self::SocketCan {
                name: rest.to_owned(),
            }),
            "gvret" => match rest.rsplit_once(':') {
                Some((host, port)) if !host.is_empty() && port.parse::<u16>().is_ok() => {
                    Ok(Self::Gvret {
                        endpoint: rest.to_owned(),
                    })
                }
                _ => Err(format!("gvret needs <host:port>, not '{rest}'")),
            },
            _ => Err(usage()),
        }
    }
}

impl fmt::Display for Interface {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::GsUsb { device, channel } => write!(f, "gsusb:{device}/{channel}"),
            Self::Pcan { device, channel } => write!(f, "pcan:{device}/{channel}"),
            Self::Slcan { port } => write!(f, "slcan:{port}"),
            Self::SocketCan { name } => write!(f, "socketcan:{name}"),
            Self::Gvret { endpoint } => write!(f, "gvret:{endpoint}"),
        }
    }
}

impl Interface {
    /// The bus number frames are sent on and read from.
    pub fn bus(&self) -> u8 {
        match self {
            Self::GsUsb { channel, .. } | Self::Pcan { channel, .. } => *channel,
            _ => 0,
        }
    }
}

#[derive(Args, Debug, Clone, Default)]
pub struct BusOptions {
    /// Nominal bit rate [default: 500000 on gs_usb and SLCAN]
    #[arg(long, global = true)]
    pub bitrate: Option<u32>,
    /// CAN FD data bit rate; enables CAN FD
    #[arg(long, global = true)]
    pub dbitrate: Option<u32>,
    /// Never acknowledge or transmit
    #[arg(long, global = true)]
    pub listen_only: bool,
    /// Nominal sample point, percent (gs_usb only)
    #[arg(long, global = true)]
    pub sample_point: Option<f32>,
    /// CAN clock override in Hz, for firmware that misreports it (gs_usb only)
    #[arg(long, global = true)]
    pub can_clock: Option<u32>,
}

impl BusOptions {
    pub fn fd(&self) -> bool {
        self.dbitrate.is_some()
    }

    fn refuse(&self, what: &str, refused: &[&str]) -> Result<(), String> {
        let given = [
            ("--bitrate", self.bitrate.is_some()),
            ("--dbitrate", self.dbitrate.is_some()),
            ("--sample-point", self.sample_point.is_some()),
            ("--can-clock", self.can_clock.is_some()),
        ];
        match given
            .iter()
            .find(|(flag, given)| *given && refused.contains(flag))
        {
            Some((flag, _)) => Err(format!("{what} cannot take {flag}")),
            None => Ok(()),
        }
    }
}

/// An interface with the options it can take, checked before anything is opened.
enum Plan {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    GsUsb(wiretap_io::can::gsusb::GsUsbOptions),
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    Pcan {
        device: UsbSelector,
        channel: u8,
        bus: BusOptions,
    },
    Slcan(slcan::SlcanOptions),
    #[cfg(target_os = "linux")]
    SocketCan {
        name: String,
        bitrate: Option<u32>,
        dbitrate: Option<u32>,
    },
    Gvret(gvret::Link),
}

fn plan(interface: &Interface, bus: &BusOptions) -> Result<Plan, String> {
    match interface {
        Interface::GsUsb { device, channel } => gs_usb_plan(device, *channel, bus),
        Interface::Pcan { device, channel } => pcan_plan(device, *channel, bus),
        Interface::Slcan { port } => {
            bus.refuse("SLCAN", &["--sample-point", "--can-clock"])?;
            Ok(Plan::Slcan(slcan::SlcanOptions {
                path: port.clone(),
                line: SLCAN_LINE,
                bitrate: bus.bitrate.unwrap_or(DEFAULT_BITRATE),
                data_bitrate: bus.dbitrate,
            }))
        }
        Interface::SocketCan { name } => socketcan_plan(name, bus),
        Interface::Gvret { endpoint } => {
            bus.refuse(
                "GVRET, whose bus rate is set on the device,",
                &["--bitrate", "--dbitrate", "--sample-point", "--can-clock"],
            )?;
            Ok(Plan::Gvret(tcp(endpoint)))
        }
    }
}

fn tcp(endpoint: &str) -> gvret::Link {
    gvret::Link::Tcp {
        endpoint: endpoint.to_owned(),
        connect_timeout: CONNECT_TIMEOUT,
    }
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn gs_usb_plan(device: &UsbSelector, channel: u8, bus: &BusOptions) -> Result<Plan, String> {
    use wiretap_io::can::gsusb::GsUsbOptions;
    let mut gs = GsUsbOptions::new(usb_device(device), bus.bitrate.unwrap_or(DEFAULT_BITRATE));
    gs.channel = channel;
    gs.sample_point = bus.sample_point;
    gs.data = bus.dbitrate.map(|rate| (rate, None));
    gs.clock_hz = bus.can_clock;
    Ok(Plan::GsUsb(gs))
}

#[cfg(target_os = "linux")]
fn gs_usb_plan(_: &UsbSelector, _: u8, _: &BusOptions) -> Result<Plan, String> {
    Err(
        "on Linux the kernel drives a gs_usb adapter as a SocketCAN interface: \
         use socketcan:<if> (list names it)"
            .to_owned(),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn pcan_plan(device: &UsbSelector, channel: u8, bus: &BusOptions) -> Result<Plan, String> {
    bus.refuse("PEAK", &["--can-clock"])?;
    Ok(Plan::Pcan {
        device: device.clone(),
        channel,
        bus: bus.clone(),
    })
}

#[cfg(target_os = "linux")]
fn pcan_plan(_: &UsbSelector, _: u8, _: &BusOptions) -> Result<Plan, String> {
    Err(
        "on Linux the kernel drives a PEAK adapter as a SocketCAN interface: \
         use socketcan:<if> (list names it)"
            .to_owned(),
    )
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn pcan_options(device: PcanDevice, channel: u8, bus: &BusOptions) -> PcanOptions {
    let mut pcan = PcanOptions::new(device, bus.bitrate.unwrap_or(DEFAULT_BITRATE));
    pcan.channel = channel;
    pcan.sample_point = bus.sample_point;
    pcan.data = bus.dbitrate.map(|rate| (rate, None));
    pcan
}

/// The library looks for an adapter only among its model's, and a serial names
/// no model, so a serial is tried on every model plugged in.
#[cfg(any(target_os = "macos", target_os = "windows"))]
fn pcan_candidates(selector: &UsbSelector, found: &[PcanDevice]) -> Vec<PcanDevice> {
    match selector {
        UsbSelector::BusAddress(bus, address) => found
            .iter()
            .filter(|device| device.bus == *bus && device.address == *address)
            .map(|device| PcanDevice {
                serial: None,
                ..device.clone()
            })
            .collect(),
        UsbSelector::Serial(serial) => {
            let mut models = Vec::new();
            for device in found {
                if !models.contains(&device.model) {
                    models.push(device.model);
                }
            }
            models
                .into_iter()
                .map(|model| PcanDevice {
                    serial: Some(serial.clone()),
                    bus: 0,
                    address: 0,
                    product: String::new(),
                    model,
                })
                .collect()
        }
    }
}

/// The first candidate that is found answers; failing all, the first reason
/// other than not finding it.
#[cfg(any(target_os = "macos", target_os = "windows"))]
async fn with_pcan<T, F: std::future::Future<Output = Result<T, CanError>>>(
    selector: &UsbSelector,
    attempt: impl Fn(PcanDevice) -> F,
) -> Result<T, CanError> {
    use std::io::ErrorKind::NotFound;
    let unopened = |source| CanError::Open {
        device: format!("pcan {selector}"),
        source,
    };
    let found = pcan::devices().map_err(unopened)?;
    let mut refused = None;
    for device in pcan_candidates(selector, &found) {
        match attempt(device).await {
            Ok(answer) => return Ok(answer),
            Err(CanError::Open { source, .. }) if source.kind() == NotFound => {}
            Err(e) => {
                refused.get_or_insert(e);
            }
        }
    }
    Err(refused.unwrap_or_else(|| unopened(NotFound.into())))
}

#[cfg(target_os = "linux")]
fn socketcan_plan(name: &str, bus: &BusOptions) -> Result<Plan, String> {
    bus.refuse(
        "SocketCAN, whose timing is set with ip link,",
        &["--sample-point", "--can-clock"],
    )?;
    Ok(Plan::SocketCan {
        name: name.to_owned(),
        bitrate: bus.bitrate,
        dbitrate: bus.dbitrate,
    })
}

#[cfg(not(target_os = "linux"))]
fn socketcan_plan(_: &str, _: &BusOptions) -> Result<Plan, String> {
    Err("SocketCAN is Linux only".to_owned())
}

#[cfg(any(target_os = "macos", target_os = "windows"))]
fn usb_device(selector: &UsbSelector) -> wiretap_io::can::gsusb::GsUsbDevice {
    let (serial, bus, address) = match selector {
        UsbSelector::Serial(serial) => (Some(serial.clone()), 0, 0),
        UsbSelector::BusAddress(bus, address) => (None, *bus, *address),
    };
    wiretap_io::can::gsusb::GsUsbDevice {
        serial,
        bus,
        address,
        product: String::new(),
    }
}

/// Frames are stamped with the host's clock. `reopen` rides out an unplug;
/// without it the first loss ends the task.
pub async fn open(
    interface: &Interface,
    bus: &BusOptions,
    own_frames: bool,
    reopen: bool,
) -> Result<CanTask, String> {
    let plan = plan(interface, bus)?;
    let mut options = CanOptions::default();
    options.listen_only = bus.listen_only;
    options.own_frames = own_frames;
    options.time = wiretap_io::can::TimeMapping::Host;
    options.reopen = reopen.then_some(Duration::from_secs(1));
    let opened = match plan {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        Plan::GsUsb(gs) => wiretap_io::can::gsusb::open(gs, options).await,
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        Plan::Pcan {
            device,
            channel,
            bus,
        } => {
            with_pcan(&device, |found| {
                pcan::open(pcan_options(found, channel, &bus), options.clone())
            })
            .await
        }
        Plan::Slcan(sl) => slcan::open(sl, options).await,
        #[cfg(target_os = "linux")]
        Plan::SocketCan {
            name,
            bitrate,
            dbitrate,
        } => {
            use wiretap_io::can::socketcan;
            let set = socketcan::bitrates(&name).map_err(|e| format!("{name}: {e}"))?;
            for (flag, wanted, actual) in [
                ("--bitrate", bitrate, set.nominal),
                ("--dbitrate", dbitrate, set.data),
            ] {
                if wanted.is_some() && wanted != actual {
                    return Err(format!(
                        "{name} runs at {}, not {flag} {}: set it with ip link",
                        actual.map_or("no rate".to_owned(), |r| r.to_string()),
                        wanted.unwrap_or_default()
                    ));
                }
            }
            let sc = socketcan::SocketCanOptions {
                interface: name,
                fd: set.data.is_some(),
            };
            socketcan::open(sc, options).await
        }
        Plan::Gvret(link) => gvret::open(link, gvret::GvretOptions::default(), options).await,
    };
    opened.map_err(|e| format!("{interface}: {e}"))
}

/// Answered once the device has taken the frame, or with the library's reason
/// it would not.
pub async fn send(writer: &CanWriter, frame: CanFrame) -> Result<(), String> {
    match writer.send(frame).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => Err(format!("write failed: {e}")),
        Err(refused) => Err(format!("refused: {refused}")),
    }
}

pub enum Probed {
    Device(DeviceInfo),
    #[cfg(target_os = "linux")]
    Rates(wiretap_io::can::socketcan::Bitrates),
}

/// Reads what the device says of itself without starting its channel.
pub async fn probe(interface: &Interface) -> Result<Probed, String> {
    plan(interface, &BusOptions::default())?;
    let info = match interface {
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        Interface::GsUsb { device, .. } => {
            wiretap_io::can::gsusb::probe(&usb_device(device), PROBE_TIMEOUT).await
        }
        #[cfg(any(target_os = "macos", target_os = "windows"))]
        Interface::Pcan { device, .. } => {
            with_pcan(device, |found| async move {
                pcan::probe(&found, PROBE_TIMEOUT).await
            })
            .await
        }
        Interface::Slcan { port } => slcan::probe(port, SLCAN_LINE, PROBE_TIMEOUT).await,
        Interface::Gvret { endpoint } => gvret::probe(tcp(endpoint), PROBE_TIMEOUT).await,
        #[cfg(target_os = "linux")]
        Interface::SocketCan { name } => {
            return wiretap_io::can::socketcan::bitrates(name)
                .map(Probed::Rates)
                .map_err(|e| format!("{name}: {e}"));
        }
        #[allow(unreachable_patterns)]
        _ => unreachable!("plan refuses it on this OS"),
    };
    info.map(Probed::Device).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(s: &str) -> Result<Interface, String> {
        s.parse()
    }

    #[test]
    fn every_interface_form_parses() {
        let cases = [
            (
                "gsusb:205933B831335010",
                Interface::GsUsb {
                    device: UsbSelector::Serial("205933B831335010".into()),
                    channel: 0,
                },
            ),
            (
                "gsusb:205933B831335010/1",
                Interface::GsUsb {
                    device: UsbSelector::Serial("205933B831335010".into()),
                    channel: 1,
                },
            ),
            (
                "gsusb:0:5",
                Interface::GsUsb {
                    device: UsbSelector::BusAddress(0, 5),
                    channel: 0,
                },
            ),
            (
                "gsusb:2:17/1",
                Interface::GsUsb {
                    device: UsbSelector::BusAddress(2, 17),
                    channel: 1,
                },
            ),
            (
                "pcan:0012ABCD",
                Interface::Pcan {
                    device: UsbSelector::Serial("0012ABCD".into()),
                    channel: 0,
                },
            ),
            (
                "pcan:1:4/1",
                Interface::Pcan {
                    device: UsbSelector::BusAddress(1, 4),
                    channel: 1,
                },
            ),
            (
                "slcan:/dev/cu.usbmodem1101",
                Interface::Slcan {
                    port: "/dev/cu.usbmodem1101".into(),
                },
            ),
            (
                "slcan:COM3",
                Interface::Slcan {
                    port: "COM3".into(),
                },
            ),
            (
                "socketcan:can0",
                Interface::SocketCan {
                    name: "can0".into(),
                },
            ),
            (
                "gvret:10.0.55.2:23",
                Interface::Gvret {
                    endpoint: "10.0.55.2:23".into(),
                },
            ),
            (
                "gvret:[::1]:2323",
                Interface::Gvret {
                    endpoint: "[::1]:2323".into(),
                },
            ),
        ];
        for (text, expected) in cases {
            assert_eq!(parse(text), Ok(expected), "{text}");
        }
    }

    #[test]
    fn a_malformed_interface_is_refused() {
        for text in [
            "can0",
            "gsusb:",
            "gsusb:/1",
            "gsusb:abc/x",
            "gsusb:0:x",
            "gsusb:300:1",
            "slcan:",
            "gvret:host",
            "gvret::23",
            "gvret:host:99999",
            "pcan:",
            "pcan:/1",
            "pcan:0:x",
            "peak:1",
        ] {
            assert!(parse(text).is_err(), "{text}");
        }
    }

    #[test]
    fn an_interface_prints_as_it_parses() {
        for text in [
            "gsusb:ABC/1",
            "gsusb:0:5/0",
            "pcan:0012ABCD/0",
            "pcan:1:4/1",
            "slcan:COM3",
            "socketcan:can0",
            "gvret:h:23",
        ] {
            assert_eq!(parse(text).unwrap().to_string(), text);
        }
    }

    #[test]
    fn a_transport_refuses_an_option_it_cannot_take() {
        let gvret = parse("gvret:host:23").unwrap();
        let slcan = parse("slcan:COM3").unwrap();
        let with = |f: fn(&mut BusOptions)| {
            let mut bus = BusOptions::default();
            f(&mut bus);
            bus
        };
        let refused = [
            (&gvret, with(|b| b.bitrate = Some(250_000)), "--bitrate"),
            (&gvret, with(|b| b.dbitrate = Some(2_000_000)), "--dbitrate"),
            (
                &gvret,
                with(|b| b.sample_point = Some(80.0)),
                "--sample-point",
            ),
            (
                &slcan,
                with(|b| b.sample_point = Some(80.0)),
                "--sample-point",
            ),
            (
                &slcan,
                with(|b| b.can_clock = Some(40_000_000)),
                "--can-clock",
            ),
        ];
        for (interface, bus, flag) in refused {
            let error = plan(interface, &bus).err().unwrap();
            assert!(error.contains(flag), "{interface}: {error}");
        }
        assert!(plan(&gvret, &with(|b| b.listen_only = true)).is_ok());
        assert!(plan(&slcan, &with(|b| b.dbitrate = Some(2_000_000))).is_ok());
    }

    #[test]
    fn slcan_takes_the_default_bitrate() {
        let Ok(Plan::Slcan(options)) = plan(&parse("slcan:COM3").unwrap(), &BusOptions::default())
        else {
            panic!("not an SLCAN plan");
        };
        assert_eq!(options.bitrate, DEFAULT_BITRATE);
        assert_eq!(options.data_bitrate, None);
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn socketcan_is_refused_off_linux() {
        let error = plan(&parse("socketcan:can0").unwrap(), &BusOptions::default())
            .err()
            .unwrap();
        assert!(error.contains("Linux only"), "{error}");
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn gs_usb_and_peak_on_linux_point_at_socketcan() {
        for text in ["gsusb:ABC", "pcan:ABC"] {
            let error = plan(&parse(text).unwrap(), &BusOptions::default())
                .err()
                .unwrap();
            assert!(error.contains("socketcan:"), "{error}");
        }
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    mod peak {
        use wiretap_io::can::pcan::PcanModel;

        use super::*;

        fn found(serial: Option<&str>, bus: u8, address: u8, model: PcanModel) -> PcanDevice {
            PcanDevice {
                serial: serial.map(str::to_owned),
                bus,
                address,
                product: model.to_string(),
                model,
            }
        }

        #[test]
        fn peak_refuses_a_can_clock_and_takes_the_rest() {
            let pcan = parse("pcan:0012ABCD").unwrap();
            let mut bus = BusOptions {
                can_clock: Some(40_000_000),
                ..BusOptions::default()
            };
            let error = plan(&pcan, &bus).err().unwrap();
            assert!(error.contains("--can-clock"), "{error}");

            bus.can_clock = None;
            bus.bitrate = Some(250_000);
            bus.dbitrate = Some(2_000_000);
            bus.sample_point = Some(80.0);
            bus.listen_only = true;
            assert!(plan(&pcan, &bus).is_ok());
        }

        #[test]
        fn the_bus_options_become_the_adapters() {
            let device = found(None, 1, 4, PcanModel::UsbProFd);
            let bus = BusOptions {
                dbitrate: Some(2_000_000),
                sample_point: Some(80.0),
                ..BusOptions::default()
            };
            let options = pcan_options(device.clone(), 1, &bus);
            assert_eq!(options.device, device);
            assert_eq!(options.channel, 1);
            assert_eq!(options.bitrate, DEFAULT_BITRATE);
            assert_eq!(options.sample_point, Some(80.0));
            assert_eq!(options.data, Some((2_000_000, None)));

            let classic = pcan_options(device, 0, &BusOptions::default());
            assert_eq!((classic.sample_point, classic.data), (None, None));
        }

        #[test]
        fn a_bus_address_is_the_adapter_there_and_a_serial_is_asked_of_each_model() {
            let plugged = [
                found(None, 1, 4, PcanModel::Usb),
                found(Some("00A1B2C3"), 1, 5, PcanModel::UsbFd),
                found(None, 2, 6, PcanModel::Usb),
            ];
            assert_eq!(
                pcan_candidates(&UsbSelector::BusAddress(1, 5), &plugged),
                [found(None, 1, 5, PcanModel::UsbFd)]
            );
            assert!(pcan_candidates(&UsbSelector::BusAddress(3, 1), &plugged).is_empty());

            let asked: Vec<_> = pcan_candidates(&UsbSelector::Serial("0012ABCD".into()), &plugged)
                .into_iter()
                .map(|device| (device.serial, device.model))
                .collect();
            assert_eq!(
                asked,
                [
                    (Some("0012ABCD".into()), PcanModel::Usb),
                    (Some("0012ABCD".into()), PcanModel::UsbFd),
                ]
            );
        }
    }
}
