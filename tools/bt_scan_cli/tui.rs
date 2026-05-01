// Live BLE TUI mode for bt_scan_cli.
//
// Runs an indefinite BLE scan via btleplug's CentralEvent stream and
// renders a live-updating ratatui table sorted Framelink-first then by
// RSSI. Quits on `q` / Esc / Ctrl+C.
//
// Detail panel (`d`) shows full advertisement contents for the selected
// device — services, service_data, manufacturer_data (hex), full
// FrameLink ManufacturerPayload (schema, caps, hw_rev, fw_version), and
// the match reason. Pressing Enter on a selected device kicks off an
// async GATT enumeration (connect → discover_services → list chars).
//
// Classic BT is intentionally skipped in TUI mode — the focus here is
// triaging BLE advertisement delivery (especially on Windows WinRT).

use std::collections::HashMap;
use std::io;
use std::time::{Duration, Instant};

use btleplug::api::{
    AddressType, BDAddr, Central, CentralEvent, Manager as _, Peripheral as _,
    PeripheralProperties, ScanFilter,
};
use btleplug::platform::{Adapter, Manager, PeripheralId};
use crossterm::{
    event::{Event, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers},
    execute, terminal,
};
use framelink::ble::{parse_peripheral, FRAMELINK_BLE_SERVICE_UUID};
use futures::StreamExt;
use ratatui::{
    backend::{Backend, CrosstermBackend},
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Cell, Clear, Paragraph, Row, Table, TableState, Wrap},
    Terminal,
};
use tokio::sync::mpsc;
use uuid::Uuid;

use crate::FRAMELINK_NAME_PATTERN;

#[derive(Clone)]
struct DeviceRow {
    ble_id: String,
    pid: PeripheralId,
    /// Resolved name for display (advertisement_name or local_name).
    name: Option<String>,
    /// btleplug 0.12: name from ADV/SCAN_RSP advertisement payload.
    advertisement_name: Option<String>,
    /// Name from the GAP characteristic (post-connect). May differ from
    /// advertisement_name on Windows when extended advertisements are used.
    local_name: Option<String>,
    rssi: Option<i16>,
    tx_power: Option<i16>,
    address: BDAddr,
    address_type: Option<AddressType>,
    services: Vec<Uuid>,
    service_data: Vec<(Uuid, Vec<u8>)>,
    manufacturer_data: Vec<(u16, Vec<u8>)>,
    framelink: Option<FramelinkMatch>,
    gatt: GattState,
    last_seen: Instant,
}

#[derive(Clone)]
enum FramelinkMatch {
    /// `parse_peripheral` succeeded — service UUID + local_name + parseable
    /// manufacturer payload. `payload` is `Some` when the cap bitmask decoded.
    BleService {
        parsed_name: String,
        payload: Option<PayloadInfo>,
    },
    /// FrameLink service UUID was advertised but `parse_peripheral` returned
    /// None (typically because `local_name` is missing — common on Windows
    /// 11 with extended advertisements where the name is in
    /// `advertisement_name` instead).
    BleUuidOnly,
    /// Name contains "WiredFlexLink" but the FrameLink service UUID was not
    /// advertised. Cross-transport fallback.
    NamePatternOnly,
}

#[derive(Clone)]
struct PayloadInfo {
    schema_version: u8,
    raw_caps: u16,
    wifi_prov: bool,
    smp: bool,
    framelink_ble: bool,
    caps_flag: bool,
    requires_pairing: bool,
    hw_rev: u8,
    fw_version: (u8, u8),
}

#[derive(Clone)]
enum GattState {
    NotEnumerated,
    Pending,
    Done(Vec<GattService>),
    Failed(String),
}

#[derive(Clone)]
struct GattService {
    uuid: Uuid,
    characteristics: Vec<GattChar>,
}

#[derive(Clone)]
struct GattChar {
    uuid: Uuid,
    properties: String,
}

struct GattResult {
    ble_id: String,
    state: GattState,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Focus {
    Table,
    Detail,
}

struct AppState {
    devices: HashMap<String, DeviceRow>,
    filter: String,
    filter_input_mode: bool,
    started: Instant,
    detail: bool,
    selected_ble_id: Option<String>,
    focus: Focus,
    detail_scroll: u16,
    show_info: bool,
    radio_info: RadioInfo,
    quit: bool,
    event_total: u64,
    error: Option<String>,
}

#[derive(Clone, Default)]
struct RadioInfo {
    host: String,
    ble_adapter_count: usize,
    ble_adapter_lines: Vec<String>,
}

pub async fn run(initial_filter: Option<String>, detail: bool) -> io::Result<()> {
    terminal::enable_raw_mode()?;
    let mut stdout = io::stdout();
    execute!(stdout, terminal::EnterAlternateScreen)?;
    let mut terminal = Terminal::new(CrosstermBackend::new(stdout))?;

    let result = run_app(&mut terminal, initial_filter, detail).await;

    terminal::disable_raw_mode()?;
    execute!(terminal.backend_mut(), terminal::LeaveAlternateScreen)?;
    terminal.show_cursor()?;

    result
}

async fn run_app<B: Backend>(
    terminal: &mut Terminal<B>,
    initial_filter: Option<String>,
    detail: bool,
) -> io::Result<()> {
    let mut state = AppState {
        devices: HashMap::new(),
        filter: initial_filter.unwrap_or_default(),
        filter_input_mode: false,
        started: Instant::now(),
        detail,
        selected_ble_id: None,
        focus: Focus::Table,
        detail_scroll: 0,
        show_info: false,
        radio_info: RadioInfo::default(),
        quit: false,
        event_total: 0,
        error: None,
    };

    let manager = match Manager::new().await {
        Ok(m) => m,
        Err(e) => {
            state.error = Some(format!("Manager::new failed: {e}"));
            return show_error_and_wait(terminal, state).await;
        }
    };
    state.radio_info = collect_radio_info(&manager).await;
    let adapter = match manager.adapters().await.ok().and_then(|a| a.into_iter().next()) {
        Some(a) => a,
        None => {
            state.error = Some("No BLE adapter found".to_string());
            return show_error_and_wait(terminal, state).await;
        }
    };
    let mut ble_events = match adapter.events().await {
        Ok(e) => e,
        Err(e) => {
            state.error = Some(format!("adapter.events() failed: {e}"));
            return show_error_and_wait(terminal, state).await;
        }
    };
    if let Err(e) = adapter.start_scan(ScanFilter::default()).await {
        state.error = Some(format!("start_scan failed: {e}"));
        return show_error_and_wait(terminal, state).await;
    }

    let (gatt_tx, mut gatt_rx) = mpsc::unbounded_channel::<GattResult>();
    let mut key_events = EventStream::new();
    let mut tick = tokio::time::interval(Duration::from_millis(200));

    while !state.quit {
        terminal.draw(|f| draw(f, &state))?;

        tokio::select! {
            ble_event = ble_events.next() => {
                match ble_event {
                    Some(CentralEvent::DeviceDiscovered(id))
                    | Some(CentralEvent::DeviceUpdated(id)) => {
                        state.event_total += 1;
                        if let Ok(p) = adapter.peripheral(&id).await {
                            if let Some(props) = p.properties().await.ok().flatten() {
                                let key = id.to_string();
                                let prev_gatt = state
                                    .devices
                                    .get(&key)
                                    .map(|d| d.gatt.clone())
                                    .unwrap_or(GattState::NotEnumerated);
                                let mut row = build_row(id.clone(), &props);
                                row.gatt = prev_gatt;
                                state.devices.insert(key, row);
                            }
                        }
                    }
                    Some(_) => {}
                    None => break,
                }
            }
            key = key_events.next() => {
                if let Some(Ok(Event::Key(k))) = key {
                    if k.kind == KeyEventKind::Press {
                        handle_key(&mut state, k, &adapter, &gatt_tx);
                    }
                }
            }
            res = gatt_rx.recv() => {
                if let Some(GattResult { ble_id, state: gatt_state }) = res {
                    if let Some(row) = state.devices.get_mut(&ble_id) {
                        row.gatt = gatt_state;
                    }
                }
            }
            _ = tick.tick() => {}
        }
    }

    let _ = adapter.stop_scan().await;
    Ok(())
}

async fn show_error_and_wait<B: Backend>(
    terminal: &mut Terminal<B>,
    state: AppState,
) -> io::Result<()> {
    let mut key_events = EventStream::new();
    loop {
        terminal.draw(|f| draw(f, &state))?;
        if let Some(Ok(Event::Key(k))) = key_events.next().await {
            if k.kind != KeyEventKind::Press {
                continue;
            }
            if matches!(k.code, KeyCode::Char('q') | KeyCode::Esc)
                || (k.code == KeyCode::Char('c') && k.modifiers.contains(KeyModifiers::CONTROL))
            {
                break;
            }
        }
    }
    Ok(())
}

fn handle_key(
    state: &mut AppState,
    key: KeyEvent,
    adapter: &Adapter,
    gatt_tx: &mpsc::UnboundedSender<GattResult>,
) {
    if state.filter_input_mode {
        match key.code {
            KeyCode::Enter => state.filter_input_mode = false,
            KeyCode::Esc => {
                state.filter_input_mode = false;
                state.filter.clear();
            }
            KeyCode::Backspace => {
                state.filter.pop();
            }
            KeyCode::Char(c) => state.filter.push(c),
            _ => {}
        }
        return;
    }

    if state.show_info {
        match (key.code, key.modifiers) {
            (KeyCode::Char('i'), _) | (KeyCode::Esc, _) => state.show_info = false,
            (KeyCode::Char('q'), _) => state.quit = true,
            (KeyCode::Char('c'), m) if m.contains(KeyModifiers::CONTROL) => state.quit = true,
            _ => {}
        }
        return;
    }

    match (key.code, key.modifiers) {
        (KeyCode::Char('q') | KeyCode::Esc, _) => state.quit = true,
        (KeyCode::Char('c'), m) if m.contains(KeyModifiers::CONTROL) => state.quit = true,
        (KeyCode::Char('i'), _) => state.show_info = true,
        (KeyCode::Char('/'), _) => state.filter_input_mode = true,
        (KeyCode::Char('d'), _) => {
            state.detail = !state.detail;
            if !state.detail {
                state.focus = Focus::Table;
            }
        }
        (KeyCode::Tab, _) => {
            // First Tab opens the detail pane and focuses it; subsequent
            // Tabs toggle focus between the table and the detail pane.
            if !state.detail {
                state.detail = true;
                state.focus = Focus::Detail;
            } else {
                state.focus = match state.focus {
                    Focus::Table => Focus::Detail,
                    Focus::Detail => Focus::Table,
                };
            }
        }
        (KeyCode::Char('x'), _) => {
            state.devices.clear();
            state.selected_ble_id = None;
            state.detail_scroll = 0;
        }
        (KeyCode::Up, _) => match state.focus {
            Focus::Table => move_selection(state, -1),
            Focus::Detail => state.detail_scroll = state.detail_scroll.saturating_sub(1),
        },
        (KeyCode::Down, _) => match state.focus {
            Focus::Table => move_selection(state, 1),
            Focus::Detail => state.detail_scroll = state.detail_scroll.saturating_add(1),
        },
        (KeyCode::PageUp, _) => match state.focus {
            Focus::Table => move_selection(state, -10),
            Focus::Detail => state.detail_scroll = state.detail_scroll.saturating_sub(10),
        },
        (KeyCode::PageDown, _) => match state.focus {
            Focus::Table => move_selection(state, 10),
            Focus::Detail => state.detail_scroll = state.detail_scroll.saturating_add(10),
        },
        (KeyCode::Home, _) => {
            if state.focus == Focus::Detail {
                state.detail_scroll = 0;
            }
        }
        (KeyCode::Enter, _) => trigger_gatt(state, adapter, gatt_tx),
        _ => {}
    }
}

fn trigger_gatt(
    state: &mut AppState,
    adapter: &Adapter,
    gatt_tx: &mpsc::UnboundedSender<GattResult>,
) {
    let Some(ble_id) = state.selected_ble_id.clone() else {
        return;
    };
    let Some(row) = state.devices.get_mut(&ble_id) else {
        return;
    };
    if matches!(row.gatt, GattState::Pending) {
        return; // already in flight
    }
    let pid = row.pid.clone();
    row.gatt = GattState::Pending;

    let adapter_clone = adapter.clone();
    let tx_clone = gatt_tx.clone();
    tokio::spawn(async move {
        let new_state = enumerate_gatt(adapter_clone, pid).await;
        let _ = tx_clone.send(GattResult {
            ble_id,
            state: new_state,
        });
    });
}

async fn collect_radio_info(manager: &Manager) -> RadioInfo {
    let host = format!(
        "{} {}",
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    let mut lines = Vec::new();
    let mut count = 0;
    match manager.adapters().await {
        Ok(adapters) => {
            count = adapters.len();
            if adapters.is_empty() {
                lines.push("(no BLE adapter found by btleplug)".to_string());
            }
            for (i, a) in adapters.iter().enumerate() {
                let info = a
                    .adapter_info()
                    .await
                    .unwrap_or_else(|e| format!("<adapter_info failed: {e}>"));
                lines.push(format!("[{i}] {info}"));
            }
        }
        Err(e) => lines.push(format!("manager.adapters() failed: {e}")),
    }
    RadioInfo {
        host,
        ble_adapter_count: count,
        ble_adapter_lines: lines,
    }
}

async fn enumerate_gatt(adapter: Adapter, pid: PeripheralId) -> GattState {
    let p = match adapter.peripheral(&pid).await {
        Ok(p) => p,
        Err(e) => return GattState::Failed(format!("peripheral lookup: {e}")),
    };
    if let Err(e) = p.connect().await {
        return GattState::Failed(format!("connect: {e}"));
    }
    let result = match p.discover_services().await {
        Ok(()) => {
            let services = p
                .services()
                .into_iter()
                .map(|s| GattService {
                    uuid: s.uuid,
                    characteristics: s
                        .characteristics
                        .into_iter()
                        .map(|c| GattChar {
                            uuid: c.uuid,
                            properties: format!("{:?}", c.properties),
                        })
                        .collect(),
                })
                .collect();
            GattState::Done(services)
        }
        Err(e) => GattState::Failed(format!("discover_services: {e}")),
    };
    let _ = p.disconnect().await;
    result
}

fn move_selection(state: &mut AppState, delta: i32) {
    let visible = visible_rows(state);
    if visible.is_empty() {
        state.selected_ble_id = None;
        state.detail_scroll = 0;
        return;
    }
    let current = state
        .selected_ble_id
        .as_ref()
        .and_then(|id| visible.iter().position(|d| &d.ble_id == id));
    let new_idx = match current {
        Some(i) => {
            let len = visible.len() as i32;
            ((i as i32 + delta).rem_euclid(len)) as usize
        }
        None => {
            if delta >= 0 {
                0
            } else {
                visible.len() - 1
            }
        }
    };
    let new_id = visible[new_idx].ble_id.clone();
    if Some(&new_id) != state.selected_ble_id.as_ref() {
        state.detail_scroll = 0;
    }
    state.selected_ble_id = Some(new_id);
}

fn visible_rows(state: &AppState) -> Vec<&DeviceRow> {
    let filter_lc = state.filter.to_lowercase();
    let mut rows: Vec<&DeviceRow> = state
        .devices
        .values()
        .filter(|d| {
            if state.filter.is_empty() {
                return true;
            }
            // Match against either name field — Win11 may put the visible
            // name in advertisement_name only.
            [d.advertisement_name.as_deref(), d.local_name.as_deref()]
                .iter()
                .flatten()
                .any(|n| n.to_lowercase().contains(&filter_lc))
        })
        .collect();
    rows.sort_by(|a, b| {
        b.framelink
            .is_some()
            .cmp(&a.framelink.is_some())
            .then_with(|| b.rssi.cmp(&a.rssi))
            .then_with(|| a.name.cmp(&b.name))
    });
    rows
}

fn build_row(pid: PeripheralId, props: &PeripheralProperties) -> DeviceRow {
    let ble_id = pid.to_string();
    let framelink = derive_framelink_match(&ble_id, props);
    let mut service_data: Vec<_> = props
        .service_data
        .iter()
        .map(|(u, v)| (*u, v.clone()))
        .collect();
    service_data.sort_by_key(|(u, _)| *u);
    let mut manufacturer_data: Vec<_> = props
        .manufacturer_data
        .iter()
        .map(|(c, v)| (*c, v.clone()))
        .collect();
    manufacturer_data.sort_by_key(|(c, _)| *c);

    // btleplug 0.12 splits the advertised name (ADV/SCAN_RSP) from
    // local_name (post-connect GAP characteristic). Prefer
    // advertisement_name — that's the only one available pre-connect.
    let resolved_name = props
        .advertisement_name
        .clone()
        .or_else(|| props.local_name.clone());

    DeviceRow {
        ble_id,
        pid,
        name: resolved_name,
        advertisement_name: props.advertisement_name.clone(),
        local_name: props.local_name.clone(),
        rssi: props.rssi,
        tx_power: props.tx_power_level,
        address: props.address,
        address_type: props.address_type,
        services: props.services.clone(),
        service_data,
        manufacturer_data,
        framelink,
        gatt: GattState::NotEnumerated,
        last_seen: Instant::now(),
    }
}

fn derive_framelink_match(ble_id: &str, props: &PeripheralProperties) -> Option<FramelinkMatch> {
    if let Some(parsed) = parse_peripheral(ble_id.to_string(), props) {
        let payload = parsed.payload.as_ref().map(|p| {
            let c = p.capabilities;
            PayloadInfo {
                schema_version: p.schema_version,
                raw_caps: c.bits(),
                wifi_prov: c.has_wifi_prov(),
                smp: c.has_smp(),
                framelink_ble: c.has_framelink_ble(),
                caps_flag: c.has_caps(),
                requires_pairing: c.requires_pairing(),
                hw_rev: p.hw_rev,
                fw_version: p.fw_version,
            }
        });
        return Some(FramelinkMatch::BleService {
            parsed_name: parsed.name,
            payload,
        });
    }
    // FrameLink service UUID present but parse_peripheral declined (usually
    // because local_name is missing — Win11 puts the name in
    // advertisement_name when extended advertisements are used).
    if props.services.contains(&FRAMELINK_BLE_SERVICE_UUID)
        || props.service_data.contains_key(&FRAMELINK_BLE_SERVICE_UUID)
    {
        return Some(FramelinkMatch::BleUuidOnly);
    }
    let names = [
        props.advertisement_name.as_deref(),
        props.local_name.as_deref(),
    ];
    if names
        .iter()
        .flatten()
        .any(|n| n.contains(FRAMELINK_NAME_PATTERN))
    {
        return Some(FramelinkMatch::NamePatternOnly);
    }
    None
}

fn capability_list(p: &PayloadInfo) -> Vec<&'static str> {
    let mut out = Vec::new();
    if p.wifi_prov {
        out.push("wifi-prov");
    }
    if p.smp {
        out.push("smp");
    }
    if p.framelink_ble {
        out.push("framelink-ble");
    }
    if p.caps_flag {
        out.push("caps");
    }
    out
}

fn hex_str(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 3);
    for (i, b) in bytes.iter().enumerate() {
        if i > 0 {
            s.push(' ');
        }
        let _ = write!(s, "{:02x}", b);
    }
    s
}

fn company_name(id: u16) -> &'static str {
    match id {
        0x0006 => "Microsoft",
        0x004c => "Apple",
        0x000f => "Broadcom",
        0x0075 => "Samsung",
        0x00e0 => "Google",
        0x0157 => "Anhui Huami",
        0x02e5 => "Espressif",
        0x0590 => "Wired Square (?)",
        _ => "vendor",
    }
}

fn draw(f: &mut ratatui::Frame, state: &AppState) {
    if let Some(err) = &state.error {
        let p = Paragraph::new(format!("Error: {err}\n\nPress q to quit."))
            .block(
                Block::default()
                    .borders(Borders::ALL)
                    .title("bt_scan_cli — error"),
            )
            .style(Style::default().fg(Color::Red));
        f.render_widget(p, f.area());
        return;
    }

    let chunks = Layout::vertical([
        Constraint::Length(3),
        Constraint::Min(0),
        Constraint::Length(3),
    ])
    .split(f.area());

    let elapsed = state.started.elapsed().as_secs_f32();
    let total = state.devices.len();
    let framelink = state
        .devices
        .values()
        .filter(|d| d.framelink.is_some())
        .count();
    let filter_display = if state.filter.is_empty() {
        "<none>".to_string()
    } else {
        format!("\"{}\"", state.filter)
    };
    let header_text = format!(
        " uptime: {elapsed:6.1}s   peripherals: {total}   framelink: {framelink}   events: {}   filter: {filter_display}",
        state.event_total
    );
    let header = Paragraph::new(header_text)
        .block(Block::default().borders(Borders::ALL).title("bt_scan_cli"));
    f.render_widget(header, chunks[0]);

    let rows = visible_rows(state);
    let selected_idx = state
        .selected_ble_id
        .as_ref()
        .and_then(|id| rows.iter().position(|d| &d.ble_id == id));

    if state.detail {
        let body = Layout::horizontal([Constraint::Percentage(55), Constraint::Percentage(45)])
            .split(chunks[1]);
        render_table(f, body[0], &rows, selected_idx, state.focus == Focus::Table);
        render_detail(
            f,
            body[1],
            &rows,
            selected_idx,
            state.detail_scroll,
            state.focus == Focus::Detail,
        );
    } else {
        render_table(f, chunks[1], &rows, selected_idx, true);
    }

    let footer_text = if state.filter_input_mode {
        format!(" filter: {}_   [Enter] apply   [Esc] clear", state.filter)
    } else if state.detail && state.focus == Focus::Detail {
        " [q] quit   [Tab] back   [↑↓ PgUp/PgDn] scroll   [Home] top   [i] info   [d] hide".to_string()
    } else if state.detail {
        " [q] quit   [/] filter   [↑↓] select   [Enter] GATT   [Tab] focus detail   [i] info   [d] hide".to_string()
    } else {
        " [q] quit   [/] filter   [↑↓] select   [Enter] GATT   [Tab/d] open detail   [i] info".to_string()
    };
    let footer = Paragraph::new(footer_text).block(Block::default().borders(Borders::ALL));
    f.render_widget(footer, chunks[2]);

    if state.show_info {
        render_info_modal(f, &state.radio_info);
    }
}

fn render_info_modal(f: &mut ratatui::Frame, info: &RadioInfo) {
    let popup = centred_rect(60, 50, f.area());
    f.render_widget(Clear, popup);

    let label = Style::default().fg(Color::Cyan);
    let dim = Style::default().fg(Color::DarkGray);

    let mut lines: Vec<Line> = Vec::new();
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("  host:           ", label),
        Span::raw(info.host.clone()),
    ]));
    lines.push(Line::from(""));
    lines.push(Line::from(vec![
        Span::styled("  BLE adapters:   ", label),
        Span::raw(info.ble_adapter_count.to_string()),
    ]));
    for line in &info.ble_adapter_lines {
        lines.push(Line::from(format!("    {line}")));
    }
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  FrameLink primary service UUID:",
        label,
    )));
    lines.push(Line::from(format!(
        "    {FRAMELINK_BLE_SERVICE_UUID}"
    )));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  Classic BT info: only available in text mode",
        dim,
    )));
    lines.push(Line::from(""));
    lines.push(Line::from(Span::styled(
        "  [i / Esc] close",
        dim,
    )));

    let block = Block::default()
        .borders(Borders::ALL)
        .border_style(Style::default().fg(Color::Cyan))
        .title(" Bluetooth Environment ");
    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .block(block);
    f.render_widget(para, popup);
}

fn centred_rect(percent_x: u16, percent_y: u16, area: Rect) -> Rect {
    let v = Layout::vertical([
        Constraint::Percentage((100 - percent_y) / 2),
        Constraint::Percentage(percent_y),
        Constraint::Percentage((100 - percent_y) / 2),
    ])
    .split(area);
    Layout::horizontal([
        Constraint::Percentage((100 - percent_x) / 2),
        Constraint::Percentage(percent_x),
        Constraint::Percentage((100 - percent_x) / 2),
    ])
    .split(v[1])[1]
}

fn render_table(
    f: &mut ratatui::Frame,
    area: ratatui::layout::Rect,
    rows: &[&DeviceRow],
    selected_idx: Option<usize>,
    focused: bool,
) {
    let now = Instant::now();
    let table_rows: Vec<Row> = rows
        .iter()
        .map(|d| {
            let age = now.duration_since(d.last_seen);
            let style = if d.framelink.is_some() {
                Style::default().fg(Color::Green).add_modifier(Modifier::BOLD)
            } else if age > Duration::from_secs(10) {
                Style::default().fg(Color::DarkGray)
            } else {
                Style::default()
            };
            Row::new(vec![
                Cell::from(d.name.clone().unwrap_or_else(|| "<unnamed>".into())),
                Cell::from(d.ble_id.clone()),
                Cell::from(
                    d.rssi
                        .map(|r| format!("{r}"))
                        .unwrap_or_else(|| "?".into()),
                ),
                Cell::from(d.services.len().to_string()),
                Cell::from(format!("{:.1}s", age.as_secs_f32())),
                Cell::from(if d.framelink.is_some() { "*" } else { "" }),
            ])
            .style(style)
        })
        .collect();

    let widths = [
        Constraint::Min(20),
        Constraint::Length(38),
        Constraint::Length(5),
        Constraint::Length(5),
        Constraint::Length(6),
        Constraint::Length(2),
    ];
    let table = Table::new(table_rows, widths)
        .header(
            Row::new(vec!["NAME", "BLE_ID", "RSSI", "SVCS", "AGE", "FL"])
                .style(Style::default().add_modifier(Modifier::BOLD)),
        )
        .row_highlight_style(Style::default().bg(Color::DarkGray))
        .highlight_symbol("> ")
        .block(focus_block("Peripherals", focused));

    let mut ts = TableState::default();
    ts.select(selected_idx);
    f.render_stateful_widget(table, area, &mut ts);
}

fn render_detail(
    f: &mut ratatui::Frame,
    area: ratatui::layout::Rect,
    rows: &[&DeviceRow],
    selected_idx: Option<usize>,
    scroll: u16,
    focused: bool,
) {
    let lines: Vec<Line> = match selected_idx.and_then(|i| rows.get(i).copied()) {
        None => vec![Line::from(Span::styled(
            "(no selection — press ↑/↓ to pick a device)",
            Style::default().fg(Color::DarkGray),
        ))],
        Some(d) => detail_lines(d),
    };

    let para = Paragraph::new(lines)
        .wrap(Wrap { trim: false })
        .scroll((scroll, 0))
        .block(focus_block("Detail", focused));
    f.render_widget(para, area);
}

fn focus_block(title: &'static str, focused: bool) -> Block<'static> {
    let title_text = if focused {
        format!(" {title} ◀ ")
    } else {
        format!(" {title} ")
    };
    let style = if focused {
        Style::default().fg(Color::Yellow)
    } else {
        Style::default().fg(Color::DarkGray)
    };
    Block::default()
        .borders(Borders::ALL)
        .border_style(style)
        .title(title_text)
}

fn detail_lines(d: &DeviceRow) -> Vec<Line<'static>> {
    let mut out: Vec<Line> = Vec::new();
    let dim = Style::default().fg(Color::DarkGray);
    let label = Style::default().fg(Color::Cyan);
    let warn = Style::default().fg(Color::Yellow);
    let green = Style::default().fg(Color::Green).add_modifier(Modifier::BOLD);

    let name = d.name.clone().unwrap_or_else(|| "<unnamed>".into());
    out.push(Line::from(Span::styled(name, green)));
    out.push(Line::from(Span::styled(d.ble_id.clone(), dim)));
    out.push(Line::from(""));

    let kv = |k: &str, v: String| -> Line<'static> {
        Line::from(vec![
            Span::styled(format!("{k:<13}: "), label),
            Span::raw(v),
        ])
    };
    out.push(kv("rssi", opt_string(d.rssi)));
    out.push(kv("tx_power", opt_string(d.tx_power)));
    out.push(kv("address", d.address.to_string()));
    out.push(kv("address_type", format!("{:?}", d.address_type)));
    // Surface both name fields — diagnostic for the Win11 advertisement_name
    // vs local_name split.
    out.push(kv(
        "adv_name",
        d.advertisement_name.clone().unwrap_or_else(|| "<none>".into()),
    ));
    out.push(kv(
        "local_name",
        d.local_name.clone().unwrap_or_else(|| "<none>".into()),
    ));
    out.push(Line::from(""));

    out.push(Line::from(Span::styled("services:", label)));
    if d.services.is_empty() {
        out.push(Line::from(Span::styled("  (none)", dim)));
    } else {
        for u in &d.services {
            let mark = if *u == FRAMELINK_BLE_SERVICE_UUID {
                Span::styled("  framelink ", green)
            } else {
                Span::raw("  ")
            };
            out.push(Line::from(vec![mark, Span::raw(u.to_string())]));
        }
    }
    out.push(Line::from(""));

    out.push(Line::from(Span::styled("service_data:", label)));
    if d.service_data.is_empty() {
        out.push(Line::from(Span::styled("  (none)", dim)));
    } else {
        for (u, bytes) in &d.service_data {
            out.push(Line::from(format!("  {u}")));
            out.push(Line::from(format!(
                "    {} bytes [{}]",
                bytes.len(),
                hex_str(bytes)
            )));
        }
    }
    out.push(Line::from(""));

    out.push(Line::from(Span::styled("manufacturer_data:", label)));
    if d.manufacturer_data.is_empty() {
        out.push(Line::from(Span::styled("  (none)", dim)));
    } else {
        for (cid, bytes) in &d.manufacturer_data {
            out.push(Line::from(format!(
                "  [0x{cid:04x} {}]",
                company_name(*cid)
            )));
            out.push(Line::from(format!(
                "    {} bytes = {}",
                bytes.len(),
                hex_str(bytes)
            )));
        }
    }
    out.push(Line::from(""));

    out.push(Line::from(Span::styled("framelink:", label)));
    match &d.framelink {
        None => out.push(Line::from(Span::styled("  not matched", dim))),
        Some(FramelinkMatch::BleUuidOnly) => {
            out.push(Line::from(Span::styled(
                "  matched on BLE service UUID",
                green,
            )));
            out.push(Line::from(Span::styled(
                "  (no parseable manufacturer payload — likely missing local_name)",
                dim,
            )));
        }
        Some(FramelinkMatch::NamePatternOnly) => {
            out.push(Line::from(Span::styled("  name pattern only", warn)));
            out.push(Line::from(Span::styled(
                "  (FrameLink service UUID not advertised)",
                dim,
            )));
        }
        Some(FramelinkMatch::BleService {
            parsed_name,
            payload,
        }) => {
            out.push(Line::from(Span::styled(
                "  matched via BLE service UUID",
                green,
            )));
            out.push(Line::from(format!("  parsed_name: {parsed_name}")));
            match payload {
                None => out.push(Line::from(Span::styled(
                    "  manufacturer payload: <missing or unparseable>",
                    warn,
                ))),
                Some(p) => {
                    out.push(Line::from(format!(
                        "  schema_version: {}",
                        p.schema_version
                    )));
                    let caps = capability_list(p);
                    let caps_s = if caps.is_empty() {
                        "(none)".to_string()
                    } else {
                        caps.join(", ")
                    };
                    out.push(Line::from(format!(
                        "  caps: {caps_s}   raw: {:#06x}",
                        p.raw_caps
                    )));
                    if p.requires_pairing {
                        out.push(Line::from(Span::styled(
                            "  requires_pairing: true",
                            warn,
                        )));
                    }
                    out.push(Line::from(format!("  hw_rev: {}", p.hw_rev)));
                    out.push(Line::from(format!(
                        "  fw_version: {}.{}",
                        p.fw_version.0, p.fw_version.1
                    )));
                }
            }
        }
    }
    out.push(Line::from(""));

    out.push(Line::from(Span::styled("GATT:", label)));
    match &d.gatt {
        GattState::NotEnumerated => out.push(Line::from(Span::styled(
            "  (press Enter to connect + enumerate)",
            dim,
        ))),
        GattState::Pending => out.push(Line::from(Span::styled("  enumerating…", warn))),
        GattState::Failed(msg) => out.push(Line::from(Span::styled(
            format!("  failed: {msg}"),
            Style::default().fg(Color::Red),
        ))),
        GattState::Done(services) => {
            out.push(Line::from(format!("  {} services", services.len())));
            for s in services {
                let mark = if s.uuid == FRAMELINK_BLE_SERVICE_UUID {
                    Span::styled("  framelink ", green)
                } else {
                    Span::raw("  service ")
                };
                out.push(Line::from(vec![mark, Span::raw(s.uuid.to_string())]));
                for c in &s.characteristics {
                    out.push(Line::from(format!(
                        "      char {} {}",
                        c.uuid, c.properties
                    )));
                }
            }
        }
    }

    out
}

fn opt_string<T: std::fmt::Display>(v: Option<T>) -> String {
    v.map(|x| x.to_string()).unwrap_or_else(|| "?".into())
}
