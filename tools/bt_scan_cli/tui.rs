// Live ratatui TUI driven by framelink::Discovery::events().
//
// Renders a sorted table of currently-known FrameLink devices, updated as
// Seen / Updated / Lost events arrive. The previous Phase-0 TUI's GATT
// deep-dive panel and "all visible peripherals" detail mode are out of
// scope here — they'll come back as `framelink-cli scan --detail` in
// Phase 5.

use std::collections::BTreeMap;
use std::io;
use std::time::{Duration, Instant};

use crossterm::event::{
    DisableMouseCapture, EnableMouseCapture, Event as CtEvent, EventStream, KeyCode, KeyEventKind,
};
use crossterm::execute;
use crossterm::terminal::{
    disable_raw_mode, enable_raw_mode, EnterAlternateScreen, LeaveAlternateScreen,
};
use framelink::{CapabilitySet, Device, DeviceId, Discovery, DiscoveryEvent, Transport};
use ratatui::backend::{Backend, CrosstermBackend};
use ratatui::layout::{Constraint, Direction, Layout};
use ratatui::style::{Color, Modifier, Style};
use ratatui::text::{Line, Span};
use ratatui::widgets::{Block, Borders, Cell, Paragraph, Row, Table};
use ratatui::Terminal;
use tokio_stream::StreamExt;

pub async fn run() -> io::Result<()> {
    enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, EnterAlternateScreen, EnableMouseCapture)?;
    let backend = CrosstermBackend::new(stdout);
    let mut terminal = Terminal::new(backend)?;

    let outcome = run_app(&mut terminal).await;

    disable_raw_mode()?;
    execute!(
        terminal.backend_mut(),
        LeaveAlternateScreen,
        DisableMouseCapture
    )?;
    terminal.show_cursor()?;

    outcome
}

#[derive(Clone)]
struct DeviceRow {
    device: Device,
    last_event: Instant,
}

struct AppState {
    rows: BTreeMap<DeviceId, DeviceRow>,
    last_error: Option<(Instant, String)>,
    seen_count: usize,
    started: Instant,
}

impl AppState {
    fn new() -> Self {
        Self {
            rows: BTreeMap::new(),
            last_error: None,
            seen_count: 0,
            started: Instant::now(),
        }
    }

    fn handle_event(&mut self, evt: DiscoveryEvent) {
        match evt {
            DiscoveryEvent::Seen { device } => {
                self.seen_count += 1;
                self.rows.insert(
                    device.id().clone(),
                    DeviceRow {
                        device,
                        last_event: Instant::now(),
                    },
                );
            }
            DiscoveryEvent::Updated {
                id,
                name,
                capabilities,
                rssi,
            } => {
                if let Some(row) = self.rows.get_mut(&id) {
                    // Rebuild the snapshot with the updated mutable fields,
                    // preserving transports and address.
                    let mut builder = Device::builder(id.clone(), name)
                        .capabilities(capabilities)
                        .maybe_rssi(rssi);
                    for &t in row.device.transports() {
                        builder = builder.transport(t);
                    }
                    if let Some(addr) = row.device.address() {
                        builder = builder.address(addr);
                    }
                    row.device = builder.build();
                    row.last_event = Instant::now();
                }
            }
            DiscoveryEvent::Lost { id } => {
                self.rows.remove(&id);
            }
            DiscoveryEvent::Error { source, message } => {
                self.last_error = Some((Instant::now(), format!("{source:?}: {message}")));
            }
        }
    }

    fn rows_sorted_by_name(&self) -> Vec<&DeviceRow> {
        let mut v: Vec<&DeviceRow> = self.rows.values().collect();
        v.sort_by(|a, b| {
            a.device
                .name()
                .to_lowercase()
                .cmp(&b.device.name().to_lowercase())
                .then_with(|| a.device.id().as_str().cmp(b.device.id().as_str()))
        });
        v
    }

    fn transport_breakdown(&self) -> (usize, usize, usize) {
        let (mut ble, mut tcp, mut udp) = (0, 0, 0);
        for row in self.rows.values() {
            for t in row.device.transports() {
                match t {
                    Transport::Ble => ble += 1,
                    Transport::Tcp => tcp += 1,
                    Transport::Udp => udp += 1,
                }
            }
        }
        (ble, tcp, udp)
    }
}

async fn run_app<B: Backend>(terminal: &mut Terminal<B>) -> io::Result<()> {
    let discovery = match Discovery::start().await {
        Ok(d) => d,
        Err(e) => {
            terminal.draw(|f| {
                let para = Paragraph::new(format!(
                    "Discovery::start() failed:\n\n  {e}\n\n(press any key)"
                ))
                .block(Block::default().borders(Borders::ALL).title(" Error "));
                f.render_widget(para, f.area());
            })?;
            let mut keys = EventStream::new();
            let _ = keys.next().await;
            return Ok(());
        }
    };

    let mut state = AppState::new();
    let mut events = discovery.events();
    let mut keys = EventStream::new();
    let mut redraw = tokio::time::interval(Duration::from_millis(250));

    loop {
        terminal.draw(|f| draw(f, &state))?;

        tokio::select! {
            biased;
            Some(Ok(ct)) = keys.next() => {
                if let CtEvent::Key(k) = ct {
                    if k.kind == KeyEventKind::Press {
                        match k.code {
                            KeyCode::Char('q') | KeyCode::Esc => return Ok(()),
                            KeyCode::Char('c') if k.modifiers.contains(crossterm::event::KeyModifiers::CONTROL) => {
                                return Ok(());
                            }
                            KeyCode::Char('r') => state.last_error = None,
                            _ => {}
                        }
                    }
                }
            }
            Some(evt) = events.next() => state.handle_event(evt),
            _ = redraw.tick() => {} // periodic redraw for "last seen N s ago"
        }
    }
}

fn draw(f: &mut ratatui::Frame, state: &AppState) {
    let chunks = Layout::default()
        .direction(Direction::Vertical)
        .constraints([
            Constraint::Length(3), // header
            Constraint::Min(3),    // table
            Constraint::Length(3), // footer
        ])
        .split(f.area());

    f.render_widget(header(state), chunks[0]);
    f.render_widget(device_table(state), chunks[1]);
    f.render_widget(footer(state), chunks[2]);
}

fn header(state: &AppState) -> Paragraph<'_> {
    let (ble, tcp, udp) = state.transport_breakdown();
    let runtime = state.started.elapsed().as_secs();
    let line = Line::from(vec![
        Span::styled("bt_scan_cli", Style::default().add_modifier(Modifier::BOLD)),
        Span::raw("    framelink::Discovery (live)    "),
        Span::raw(format!(
            "devices={}  ble={ble} tcp={tcp} udp={udp}  total seen={}  uptime={}s",
            state.rows.len(),
            state.seen_count,
            runtime
        )),
    ]);
    Paragraph::new(line).block(Block::default().borders(Borders::ALL).title(" status "))
}

fn device_table(state: &AppState) -> Table<'_> {
    let header_cells = ["Name", "Id", "Transports", "Capabilities", "RSSI", "Address", "Seen"]
        .iter()
        .map(|h| Cell::from(*h).style(Style::default().add_modifier(Modifier::BOLD)));
    let header = Row::new(header_cells).height(1);

    let rows: Vec<Row> = state
        .rows_sorted_by_name()
        .into_iter()
        .map(|row| {
            let secs_ago = row.last_event.elapsed().as_secs();
            let transports = row
                .device
                .transports()
                .iter()
                .map(|t| t.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let caps = format_caps(row.device.capabilities());
            let rssi = row
                .device
                .rssi()
                .map(|r| r.to_string())
                .unwrap_or_else(|| "—".into());
            let addr = row
                .device
                .address()
                .map(|a| a.to_string())
                .unwrap_or_else(|| "—".into());
            Row::new(vec![
                Cell::from(row.device.name().to_owned()),
                Cell::from(row.device.id().as_str().to_owned()),
                Cell::from(transports),
                Cell::from(caps),
                Cell::from(rssi),
                Cell::from(addr),
                Cell::from(format!("{secs_ago}s")),
            ])
        })
        .collect();

    let widths = [
        Constraint::Length(28),
        Constraint::Length(40),
        Constraint::Length(12),
        Constraint::Length(28),
        Constraint::Length(6),
        Constraint::Length(22),
        Constraint::Length(8),
    ];
    Table::new(rows, widths)
        .header(header)
        .block(Block::default().borders(Borders::ALL).title(" devices "))
}

fn footer(state: &AppState) -> Paragraph<'_> {
    let mut lines: Vec<Line> = Vec::new();
    if let Some((when, msg)) = &state.last_error {
        let age = when.elapsed().as_secs();
        lines.push(Line::from(vec![
            Span::styled(
                "ERROR",
                Style::default()
                    .fg(Color::Red)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::raw(format!(" ({age}s ago): {msg}    [r] clear")),
        ]));
    }
    lines.push(Line::from(Span::styled(
        "[q]/Esc quit  [r] clear last error",
        Style::default().fg(Color::DarkGray),
    )));
    Paragraph::new(lines).block(Block::default().borders(Borders::ALL).title(" controls "))
}

fn format_caps(caps: CapabilitySet) -> String {
    if caps.is_empty() {
        "—".to_owned()
    } else {
        caps.to_string()
    }
}
