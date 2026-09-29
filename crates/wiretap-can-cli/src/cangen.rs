use clap::Args;
use wiretap_io::can::CanFrame;
use wiretap_protocol::{dlc_to_len, len_to_dlc, ARB_MASK_EXT, ARB_MASK_STD};

/// cangen's deterministic modes: each of -I, -L and -D is `i` (increment) or
/// fixed. Where cangen would pick at random, the id and length increment and
/// the data is zeros.
#[derive(Args, Debug, Clone)]
pub struct GenArgs {
    /// Gap between frames in milliseconds
    #[arg(short = 'g', default_value_t = 200.0)]
    pub gap_ms: f64,
    /// Stop after this many frames
    #[arg(short = 'n')]
    pub count: Option<u64>,
    /// Id: `i` or hex
    #[arg(short = 'I', default_value = "i")]
    id: String,
    /// Length: `i` or bytes
    #[arg(short = 'L', default_value = "i")]
    len: String,
    /// Data: `i` or hex [default: zeros]
    #[arg(short = 'D')]
    data: Option<String>,
    /// Extended ids
    #[arg(short = 'e')]
    extended: bool,
    /// Remote frames
    #[arg(short = 'R')]
    rtr: bool,
    /// CAN FD frames
    #[arg(short = 'f')]
    fd: bool,
    /// CAN FD frames with bit rate switching
    #[arg(short = 'b')]
    brs: bool,
}

enum Mode<T> {
    Increment,
    Fixed(T),
}

fn mode<T>(text: &str, what: &str, fixed: impl Fn(&str) -> Option<T>) -> Result<Mode<T>, String> {
    match text {
        "i" => Ok(Mode::Increment),
        "r" | "e" | "o" => Err(format!(
            "{what} mode '{text}' is random; only i and fixed values are offered"
        )),
        _ => fixed(text)
            .map(Mode::Fixed)
            .ok_or_else(|| format!("'{text}' is not a {what}")),
    }
}

/// The frames cangen sends for the same options, in order, as can-utils builds
/// them: the id, length code and a little-endian counter each step after a
/// frame, and the counter never sent in an empty frame.
pub struct Generator {
    bus: u8,
    extended: bool,
    rtr: bool,
    fd: bool,
    brs: bool,
    id_increments: bool,
    len_increments: bool,
    fixed_data: Option<[u8; 64]>,
    can_id: u32,
    len: usize,
    code: u8,
    counter: u64,
}

impl Generator {
    pub fn new(args: &GenArgs, bus: u8) -> Result<Self, String> {
        let fd = args.fd || args.brs;
        if args.rtr && fd {
            return Err("CAN FD has no remote frames: drop -R or -f/-b".to_owned());
        }
        let id = mode(&args.id, "hex id", |t| u32::from_str_radix(t, 16).ok())?;
        let len = mode(&args.len, "length", |t| t.parse::<usize>().ok())?;
        let data = mode(args.data.as_deref().unwrap_or(""), "hex payload", |t| {
            let bytes = hex::decode(t).ok().filter(|b| b.len() <= 64)?;
            let mut fixed = [0; 64];
            fixed[..bytes.len()].copy_from_slice(&bytes);
            Some(fixed)
        })?;
        let can_id = match id {
            Mode::Fixed(id) if id > ARB_MASK_STD && !args.extended => {
                return Err(format!("id {id:X} is over 7FF: add -e"));
            }
            Mode::Fixed(id) => id,
            Mode::Increment => 0,
        };
        let len_increments = matches!(len, Mode::Increment);
        let len = match len {
            Mode::Fixed(n) if fd => dlc_to_len(len_to_dlc(n.min(64)), true),
            Mode::Fixed(n) => n.min(8),
            Mode::Increment => 0,
        };
        Ok(Self {
            bus,
            extended: args.extended,
            rtr: args.rtr,
            fd,
            brs: args.brs,
            id_increments: matches!(id, Mode::Increment),
            len_increments,
            fixed_data: match data {
                Mode::Fixed(bytes) => Some(bytes),
                Mode::Increment => None,
            },
            can_id,
            len,
            code: 0,
            counter: 0,
        })
    }
}

impl Iterator for Generator {
    type Item = CanFrame;

    fn next(&mut self) -> Option<CanFrame> {
        let arb_id = self.can_id
            & if self.extended {
                ARB_MASK_EXT
            } else {
                ARB_MASK_STD
            };
        if self.fixed_data.is_none() && self.len == 0 {
            self.len = 1;
        }
        let payload = self.fixed_data.unwrap_or_else(|| {
            let mut counted = [0; 64];
            counted[..8].copy_from_slice(&self.counter.to_le_bytes());
            counted
        })[..self.len]
            .to_vec();
        let frame = if self.rtr {
            CanFrame::remote(self.bus, arb_id, self.extended, self.len as u8)
        } else {
            CanFrame::data(self.bus, arb_id, self.extended, self.fd, self.brs, payload)
        };

        if self.id_increments {
            self.can_id = self.can_id.wrapping_add(1);
        }
        if self.len_increments {
            self.code = (self.code + 1) % if self.fd { 16 } else { 9 };
            self.len = dlc_to_len(self.code, self.fd);
        }
        self.counter = self.counter.wrapping_add(1);
        Some(frame)
    }
}

#[cfg(test)]
mod tests {
    use clap::Parser;

    use super::*;
    use crate::candump;

    #[derive(Parser)]
    struct Cli {
        #[command(flatten)]
        gen: GenArgs,
    }

    fn frames(args: &str, n: usize) -> Vec<String> {
        let cli = Cli::try_parse_from(std::iter::once("gen").chain(args.split_whitespace()))
            .unwrap_or_else(|e| panic!("{e}"));
        Generator::new(&cli.gen, 0)
            .unwrap_or_else(|e| panic!("{e}"))
            .take(n)
            .map(|frame| {
                let line = candump::line(std::time::UNIX_EPOCH, "x", &frame, None);
                line.rsplit(' ').next().unwrap().to_owned()
            })
            .collect()
    }

    fn refused(args: &str) -> String {
        let cli = Cli::try_parse_from(std::iter::once("gen").chain(args.split_whitespace()))
            .unwrap_or_else(|e| panic!("{e}"));
        Generator::new(&cli.gen, 0).err().expect("refused")
    }

    #[test]
    fn increment_everything_matches_can_utils() {
        assert_eq!(
            frames("-I i -L i -D i", 11),
            [
                "000#00",
                "001#01",
                "002#0200",
                "003#030000",
                "004#04000000",
                "005#0500000000",
                "006#060000000000",
                "007#07000000000000",
                "008#0800000000000000",
                "009#09",
                "00A#0A",
            ]
        );
    }

    #[test]
    fn the_counter_is_little_endian_and_wraps_the_id() {
        let lines = frames("-I 7FE -L 8 -D i", 300);
        assert_eq!(lines[0], "7FE#0000000000000000");
        assert_eq!(lines[1], "7FE#0100000000000000");
        assert_eq!(lines[258], "7FE#0201000000000000");
        let lines = frames("-I i -L 2 -D i", 3000);
        assert_eq!(lines[0x7FF], "7FF#FF07");
        assert_eq!(lines[0x800], "000#0008");
    }

    #[test]
    fn fd_walks_every_length_code_and_counts_in_the_first_eight_bytes() {
        let lines = frames("-b -I 100 -L i -D i", 17);
        assert_eq!(lines[0], "100##100");
        assert_eq!(lines[8], "100##10800000000000000");
        assert_eq!(lines[9], format!("100##109{}", "00".repeat(11)));
        assert_eq!(lines[15], format!("100##10F{}", "00".repeat(63)));
        assert_eq!(lines[16], "100##110");
        assert_eq!(frames("-f -I 1 -L 2 -D i", 1), ["001##00000"]);
    }

    #[test]
    fn a_fixed_fd_length_rounds_up_to_a_length_code() {
        assert_eq!(
            frames("-f -I 1 -L 9 -D 11", 1),
            [format!("001##011{}", "00".repeat(11))]
        );
    }

    #[test]
    fn fixed_data_is_cut_to_the_length_and_a_zero_length_kept() {
        assert_eq!(
            frames("-I 123 -L 2 -D DEADBEEF", 2),
            ["123#DEAD", "123#DEAD"]
        );
        assert_eq!(frames("-I 123 -L 0 -D DEADBEEF", 1), ["123#"]);
        assert_eq!(frames("-I 123 -L 12 -D 01", 1), ["123#0100000000000000"]);
    }

    #[test]
    fn extended_and_remote_frames() {
        assert_eq!(
            frames("-e -I 1FFFFFFF -L 1 -D i", 2),
            ["1FFFFFFF#00", "1FFFFFFF#01"]
        );
        assert_eq!(frames("-e -I i -L 1 -D i", 1), ["00000000#00"]);
        assert_eq!(
            frames("-R -I i -L i", 10)[..3],
            ["000#R", "001#R1", "002#R2"]
        );
        assert_eq!(
            frames("-R -I i -L i -D i", 10)[..3],
            ["000#R1", "001#R1", "002#R2"]
        );
        assert_eq!(frames("-I 5 -L 1", 1), ["005#00"]);
    }

    #[test]
    fn what_cangen_would_refuse_or_randomise_is_refused() {
        assert!(refused("-I 800").contains("-e"));
        assert!(refused("-R -f").contains("remote"));
        assert!(refused("-I r").contains("random"));
        assert!(refused("-D r").contains("random"));
        assert!(refused("-L x").contains("length"));
    }
}
