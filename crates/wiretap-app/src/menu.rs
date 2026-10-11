// Copyright 2026 Wired Square Pty Ltd

use std::sync::Mutex;

#[cfg(not(target_os = "ios"))]
use tauri::menu::*;
use tauri::{AppHandle, State};
#[cfg(not(target_os = "ios"))]
use tauri::{Emitter, Manager, Wry};
#[cfg(not(target_os = "ios"))]
use tauri_plugin_opener::OpenerExt;

#[cfg(not(target_os = "ios"))]
use crate::windows::{
    emit_to_focused_window, open_panel_in_focused_window, open_settings_singleton, SettingsWindowState,
};

// Store references to dynamic menu items that need to be updated at runtime
#[cfg(not(target_os = "ios"))]
struct SessionMenuItems {
    source: MenuItem<Wry>,
    picker: MenuItem<Wry>,
    play: MenuItem<Wry>,
    pause: MenuItem<Wry>,
    stop: MenuItem<Wry>,
    clear: MenuItem<Wry>,
    detach: MenuItem<Wry>,
    stop_all: MenuItem<Wry>,
}

#[cfg(not(target_os = "ios"))]
pub(crate) struct SessionMenuState(Mutex<Option<SessionMenuItems>>);

// Store reference to the Jump to Event submenu for dynamic updates
#[cfg(not(target_os = "ios"))]
pub(crate) struct EventsMenuState(Mutex<Option<Submenu<Wry>>>);

// Store references to event menu items for dynamic enable/disable
#[cfg(not(target_os = "ios"))]
struct EventMenuItems {
    add: MenuItem<Wry>,
}

#[cfg(not(target_os = "ios"))]
pub(crate) struct EventMenuItemState(Mutex<Option<EventMenuItems>>);

// iOS stub types for menu state (not used, but needed for compilation)
#[cfg(target_os = "ios")]
#[allow(dead_code)]
pub(crate) struct SessionMenuState(Mutex<()>);
#[cfg(target_os = "ios")]
#[allow(dead_code)]
pub(crate) struct EventsMenuState(Mutex<()>);
#[cfg(target_os = "ios")]
#[allow(dead_code)]
pub(crate) struct EventMenuItemState(Mutex<()>);

// Event info received from frontend for menu display
#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct EventInfo {
    id: String,
    label: String,
}

#[cfg(not(target_os = "ios"))]
pub(crate) fn manage_state(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .manage(SessionMenuState(Mutex::new(None)))
        .manage(EventsMenuState(Mutex::new(None)))
        .manage(EventMenuItemState(Mutex::new(None)))
}

#[cfg(target_os = "ios")]
pub(crate) fn manage_state(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(SessionMenuState(Mutex::new(())))
        .manage(EventsMenuState(Mutex::new(())))
        .manage(EventMenuItemState(Mutex::new(())))
}

#[cfg(not(target_os = "ios"))]
macro_rules! menu_ids {
    ($($variant:ident = $id:literal),* $(,)?) => {
        #[derive(Clone, Copy, PartialEq, Eq, Debug)]
        enum ItemId { $($variant),* }

        impl ItemId {
            #[cfg(test)]
            const ALL: &'static [ItemId] = &[$(ItemId::$variant),*];

            fn as_str(self) -> &'static str {
                match self { $(ItemId::$variant => $id),* }
            }

            fn parse(id: &str) -> Option<Self> {
                match id { $($id => Some(ItemId::$variant),)* _ => None }
            }
        }
    };
}

#[cfg(not(target_os = "ios"))]
menu_ids! {
    About = "about",
    Settings = "settings",
    NewWindow = "new-window",
    Find = "find",
    SessionSource = "session-source",
    SessionPicker = "session-picker",
    SessionImportFile = "session-import-file",
    SessionPlay = "session-play",
    SessionPause = "session-pause",
    SessionStop = "session-stop",
    SessionDetach = "session-detach",
    SessionStopAll = "session-stop-all",
    SessionClear = "session-clear",
    EventAdd = "event-add",
    EventShow = "event-show",
    HelpIssues = "help-issues",
    HelpWiki = "help-wiki",
    HelpSource = "help-source",
}

/// Apps menu items are `app-<panel id>`, one per entry in apps.json.
#[cfg(not(target_os = "ios"))]
const APP_PREFIX: &str = "app-";
/// Jump to Event items are `event-jump-<event id>`, filled in by the frontend.
#[cfg(not(target_os = "ios"))]
const EVENT_JUMP_PREFIX: &str = "event-jump-";

#[cfg(not(target_os = "ios"))]
#[derive(Debug, PartialEq, Eq)]
enum MenuAction<'a> {
    EmitToFocused(&'static str),
    OpenPanel(&'a str),
    OpenSettings,
    NewWindow,
    JumpToEvent(&'a str),
    OpenUrl(&'static str),
}

#[cfg(not(target_os = "ios"))]
impl ItemId {
    fn item(self, label: &str) -> MenuItemBuilder {
        MenuItemBuilder::with_id(self.as_str(), label)
    }

    /// Undo, redo, cut, copy, paste and select-all are predefined items the OS
    /// handles; they never reach this.
    fn action(self) -> Option<MenuAction<'static>> {
        use MenuAction::*;
        Some(match self {
            ItemId::About => EmitToFocused("show-about"),
            ItemId::Find => EmitToFocused("menu-find"),
            ItemId::Settings => OpenSettings,
            ItemId::NewWindow => NewWindow,
            ItemId::SessionSource => return None,
            ItemId::SessionPicker => EmitToFocused("menu-session-picker"),
            ItemId::SessionImportFile => EmitToFocused("menu-session-import-file"),
            ItemId::SessionPlay => EmitToFocused("menu-session-play"),
            ItemId::SessionPause => EmitToFocused("menu-session-pause"),
            ItemId::SessionStop => EmitToFocused("menu-session-stop"),
            ItemId::SessionDetach => EmitToFocused("menu-session-detach"),
            ItemId::SessionStopAll => EmitToFocused("menu-session-stop-all"),
            ItemId::SessionClear => EmitToFocused("menu-session-clear"),
            ItemId::EventAdd => EmitToFocused("menu-event-add"),
            ItemId::EventShow => OpenPanel("events"),
            ItemId::HelpIssues => OpenUrl("https://github.com/Wired-Square/WireTAP/issues"),
            ItemId::HelpWiki => OpenUrl("https://github.com/Wired-Square/WireTAP/wiki"),
            ItemId::HelpSource => OpenUrl("https://github.com/Wired-Square/WireTAP"),
        })
    }
}

#[cfg(not(target_os = "ios"))]
fn route(id: &str) -> Option<MenuAction<'_>> {
    if let Some(item) = ItemId::parse(id) {
        return item.action();
    }
    id.strip_prefix(APP_PREFIX)
        .map(MenuAction::OpenPanel)
        .or_else(|| id.strip_prefix(EVENT_JUMP_PREFIX).map(MenuAction::JumpToEvent))
}

#[cfg(not(target_os = "ios"))]
fn on_menu_event(app: &AppHandle, event: MenuEvent) {
    let Some(action) = route(event.id().as_ref()) else {
        return;
    };
    match action {
        MenuAction::EmitToFocused(name) => emit_to_focused_window(app, name, ()),
        MenuAction::OpenPanel(panel) => open_panel_in_focused_window(app, panel),
        MenuAction::OpenSettings => open_settings_singleton(app, &app.state::<SettingsWindowState>()),
        MenuAction::NewWindow => {
            // The frontend allocates a stable label and creates the window
            let _ = app.emit("menu-new-window", ());
        }
        MenuAction::JumpToEvent(event_id) => {
            emit_to_focused_window(app, "menu-jump-to-event", event_id.to_string())
        }
        MenuAction::OpenUrl(url) => {
            let _ = app.opener().open_url(url, None::<&str>);
        }
    }
}

/// Update the Session menu state based on the focused app's session.
/// When `has_session` is false, disables all session and event menu items.
/// When `has_session` is true, updates items based on session state.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn update_menu_state(
    state: State<SessionMenuState>,
    event_item_state: State<EventMenuItemState>,
    events_menu_state: State<EventsMenuState>,
    has_session: bool,
    profile_name: Option<String>,
    is_streaming: bool,
    is_paused: bool,
    can_pause: bool,
    joiner_count: u32,
    has_events: bool,
) {
    if let Some(items) = state.0.lock().unwrap().as_ref() {
        if has_session {
            let text = profile_name
                .as_ref()
                .map(|n| format!("Source: {}", n))
                .unwrap_or_else(|| "No source selected".to_string());
            let _ = items.source.set_text(&text);
            let _ = items.play.set_enabled(!is_streaming || is_paused);
            let _ = items.pause.set_enabled(is_streaming && !is_paused && can_pause);
            let _ = items.stop.set_enabled(is_streaming && !is_paused && can_pause);
            let _ = items.detach.set_enabled(is_streaming && joiner_count > 1);
            let _ = items.stop_all.set_enabled(is_streaming);
            let _ = items.picker.set_enabled(true);
            let _ = items.clear.set_enabled(true);
        } else {
            let _ = items.source.set_text("No source selected");
            let _ = items.picker.set_enabled(false);
            let _ = items.play.set_enabled(false);
            let _ = items.pause.set_enabled(false);
            let _ = items.stop.set_enabled(false);
            let _ = items.clear.set_enabled(false);
            let _ = items.detach.set_enabled(false);
            let _ = items.stop_all.set_enabled(false);
        }
    }

    // Enable/disable event items
    if let Some(items) = event_item_state.0.lock().unwrap().as_ref() {
        let _ = items.add.set_enabled(has_events);
    }
    if let Some(submenu) = events_menu_state.0.lock().unwrap().as_ref() {
        let _ = submenu.set_enabled(has_events);
    }
}

/// Update the Events > Jump to Event submenu with the focused session's events.
/// Called by the frontend when panel focus, the session or its events change.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn update_events_menu(
    app: AppHandle,
    state: State<EventsMenuState>,
    events: Vec<EventInfo>,
) -> Result<(), String> {
    if let Some(submenu) = state.0.lock().unwrap().as_ref() {
        // Collect first to avoid borrowing the submenu while removing
        let items_to_remove: Vec<_> = submenu
            .items()
            .unwrap_or_default()
            .into_iter()
            .filter(|item| {
                if let tauri::menu::MenuItemKind::MenuItem(menu_item) = item {
                    menu_item.id().0.starts_with(EVENT_JUMP_PREFIX)
                } else {
                    false
                }
            })
            .collect();

        for item in items_to_remove {
            let _ = submenu.remove(&item);
        }

        for event in events {
            let item_id = format!("{EVENT_JUMP_PREFIX}{}", event.id);
            if let Ok(menu_item) = MenuItemBuilder::with_id(&item_id, &event.label).build(&app) {
                let _ = submenu.append(&menu_item);
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn update_menu_state(
    _state: State<SessionMenuState>,
    _event_item_state: State<EventMenuItemState>,
    _events_menu_state: State<EventsMenuState>,
    _has_session: bool,
    _profile_name: Option<String>,
    _is_streaming: bool,
    _is_paused: bool,
    _can_pause: bool,
    _joiner_count: u32,
    _has_events: bool,
) {
    // No-op on iOS
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn update_events_menu(
    _app: AppHandle,
    _state: State<EventsMenuState>,
    _events: Vec<EventInfo>,
) -> Result<(), String> {
    Ok(()) // No-op on iOS
}

#[cfg(not(target_os = "ios"))]
const APPS_JSON: &str = include_str!("../../../frontend/wiretap-ui/src/apps/apps.json");

/// Shared app registry data — must match the TypeScript schema in
/// `src/apps/apps.json`. Visual concerns (icons, colours, lazy imports) are
/// layered on top in `src/apps/registry.ts` and are not represented here.
#[cfg(not(target_os = "ios"))]
#[derive(serde::Deserialize)]
struct AppRegistry {
    #[serde(rename = "groupOrder")]
    group_order: Vec<String>,
    apps: Vec<AppRegistryEntry>,
}

#[cfg(not(target_os = "ios"))]
#[derive(serde::Deserialize)]
struct AppRegistryEntry {
    id: String,
    label: String,
    group: String,
    #[serde(default)]
    accelerator: Option<String>,
    #[serde(default)]
    singleton: bool,
}

#[cfg(not(target_os = "ios"))]
impl AppRegistryEntry {
    /// Settings has its own item in the WireTAP/app submenu and is opened as a singleton.
    fn in_apps_menu(&self) -> bool {
        !self.singleton && self.group != "settings"
    }

    fn menu_id(&self) -> String {
        format!("{APP_PREFIX}{}", self.id)
    }
}

/// Build the "Apps" submenu from the shared registry, inserting separators
/// between groups in `group_order`.
#[cfg(not(target_os = "ios"))]
fn build_apps_menu(
    app: &mut tauri::App,
) -> Result<tauri::menu::Submenu<Wry>, Box<dyn std::error::Error>> {
    let registry: AppRegistry = serde_json::from_str(APPS_JSON)?;

    // Build menu items eagerly so they outlive the submenu builder.
    let mut items_by_group: std::collections::HashMap<String, Vec<MenuItem<Wry>>> =
        std::collections::HashMap::new();
    for a in registry.apps.iter().filter(|a| a.in_apps_menu()) {
        let mut builder = MenuItemBuilder::with_id(a.menu_id(), &a.label);
        if let Some(accel) = &a.accelerator {
            builder = builder.accelerator(format!("cmdOrCtrl+{}", accel));
        }
        items_by_group
            .entry(a.group.clone())
            .or_default()
            .push(builder.build(app)?);
    }

    let mut builder = SubmenuBuilder::new(app, "Apps");
    let mut group_emitted = false;
    for group in &registry.group_order {
        let Some(group_items) = items_by_group.get(group) else {
            continue;
        };
        if group_items.is_empty() {
            continue;
        }
        if group_emitted {
            builder = builder.separator();
        }
        for item in group_items {
            builder = builder.item(item);
        }
        group_emitted = true;
    }
    Ok(builder.build()?)
}

/// Setup menus for desktop platforms (not available on iOS)
#[cfg(not(target_os = "ios"))]
pub(crate) fn setup_desktop_menus(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    // Create About menu item (App submenu on macOS)
    let about_item = ItemId::About.item("About WireTAP").build(app)?;
    let settings_item = ItemId::Settings.item("Settings\u{2026}")
        .accelerator("cmdOrCtrl+,")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "WireTAP")
        .item(&about_item)
        .separator()
        .item(&settings_item)
        .separator()
        .quit()
        .build()?;

    // Apps submenu — built from the shared declarative registry at
    // `src/apps/apps.json`. That file is the single source of truth for app
    // ordering, grouping, accelerators, and labels; the TS registry consumes
    // it too. To add or rename an app, edit apps.json (and add visual config
    // in src/apps/registry.ts on the TS side); this menu picks it up.
    let apps_menu = build_apps_menu(app)?;

    // Create View menu items
    let new_window_item = ItemId::NewWindow.item("New Window")
        .accelerator("cmdOrCtrl+N")
        .build(app)?;

    // Edit menu - use predefined items for native clipboard/undo support
    let find_item = ItemId::Find.item("Find…")
        .accelerator("cmdOrCtrl+F")
        .build(app)?;

    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .separator()
        .item(&find_item)
        .build()?;

    // Create Session menu for stream control
    let session_source_item = ItemId::SessionSource.item("No source selected")
        .enabled(false)
        .build(app)?;
    let session_picker_item = ItemId::SessionPicker.item("Select Source…")
        .accelerator("cmdOrCtrl+I")
        .build(app)?;
    let session_import_item = ItemId::SessionImportFile.item("Import from File…")
        .accelerator("cmdOrCtrl+Shift+I")
        .build(app)?;

    // Playback controls (frame delivery)
    let session_play_item = ItemId::SessionPlay.item("Play")
        .accelerator("cmdOrCtrl+Return")
        .build(app)?;
    let session_pause_item = ItemId::SessionPause.item("Pause")
        .accelerator("cmdOrCtrl+.")
        .build(app)?;
    let session_stop_item = ItemId::SessionStop.item("Stop")
        .accelerator("cmdOrCtrl+Shift+.")
        .build(app)?;

    // Session connection controls
    let session_detach_item = ItemId::SessionDetach.item("Detach Session")
        .enabled(false)
        .build(app)?;
    let session_stop_all_item = ItemId::SessionStopAll.item("Stop Session")
        .build(app)?;

    let session_clear_item = ItemId::SessionClear.item("Clear Frames")
        .accelerator("cmdOrCtrl+K")
        .build(app)?;

    let session_menu = SubmenuBuilder::new(app, "Session")
        .item(&session_source_item)
        .item(&session_picker_item)
        .item(&session_import_item)
        .separator()
        .item(&session_play_item)
        .item(&session_pause_item)
        .item(&session_stop_item)
        .separator()
        .item(&session_detach_item)
        .item(&session_stop_all_item)
        .separator()
        .item(&session_clear_item)
        .build()?;

    // Create Events menu
    let event_add_item = ItemId::EventAdd.item("Add Event…")
        .accelerator("cmdOrCtrl+D")
        .build(app)?;
    let event_show_item = ItemId::EventShow.item("Show Events").build(app)?;

    // Create "Jump to Event" submenu (dynamically populated by frontend)
    let jump_to_event_submenu = SubmenuBuilder::new(app, "Jump to Event").build()?;

    let events_menu = SubmenuBuilder::new(app, "Events")
        .item(&event_add_item)
        .item(&jump_to_event_submenu)
        .separator()
        .item(&event_show_item)
        .build()?;

    // Create View submenu
    let view_menu = SubmenuBuilder::new(app, "View")
        .item(&new_window_item)
        .separator()
        .fullscreen()
        .build()?;

    // Create Help menu
    let help_issues_item = ItemId::HelpIssues.item("Report an Issue…").build(app)?;
    let help_wiki_item = ItemId::HelpWiki.item("Documentation…").build(app)?;
    let help_source_item = ItemId::HelpSource.item("Source Code…").build(app)?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .item(&help_wiki_item)
        .item(&help_issues_item)
        .separator()
        .item(&help_source_item)
        .build()?;

    // Create main menu
    let menu = MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &apps_menu,
            &edit_menu,
            &session_menu,
            &events_menu,
            &view_menu,
            &help_menu,
        ])
        .build()?;

    app.set_menu(menu)?;

    // Store session menu items for dynamic updates
    let session_menu_items = SessionMenuItems {
        source: session_source_item,
        picker: session_picker_item,
        play: session_play_item,
        pause: session_pause_item,
        stop: session_stop_item,
        clear: session_clear_item,
        detach: session_detach_item,
        stop_all: session_stop_all_item,
    };
    *app.state::<SessionMenuState>().0.lock().unwrap() = Some(session_menu_items);

    *app.state::<EventMenuItemState>().0.lock().unwrap() = Some(EventMenuItems { add: event_add_item });
    *app.state::<EventsMenuState>().0.lock().unwrap() = Some(jump_to_event_submenu);

    app.on_menu_event(on_menu_event);

    Ok(())
}

#[cfg(all(test, not(target_os = "ios")))]
mod tests {
    use super::*;

    #[test]
    fn every_fixed_id_round_trips_and_only_the_source_label_has_no_action() {
        for &id in ItemId::ALL {
            assert_eq!(ItemId::parse(id.as_str()), Some(id));
            assert_eq!(route(id.as_str()).is_none(), id == ItemId::SessionSource, "{id:?}");
        }
    }

    #[test]
    fn no_fixed_id_is_shadowed_by_a_prefix() {
        for &id in ItemId::ALL {
            assert!(!id.as_str().starts_with(APP_PREFIX), "{id:?}");
            assert!(!id.as_str().starts_with(EVENT_JUMP_PREFIX), "{id:?}");
        }
    }

    #[test]
    fn every_apps_menu_item_opens_its_panel() {
        let registry: AppRegistry = serde_json::from_str(APPS_JSON).unwrap();
        let in_menu: Vec<_> = registry.apps.iter().filter(|a| a.in_apps_menu()).collect();
        assert!(!in_menu.is_empty());
        for a in in_menu {
            let id = a.menu_id();
            assert_eq!(ItemId::parse(&id), None, "{id} collides with a fixed item");
            assert_eq!(route(&id), Some(MenuAction::OpenPanel(&a.id)));
        }
    }

    #[test]
    fn a_jump_item_routes_to_its_event() {
        assert_eq!(route("event-jump-ev_42"), Some(MenuAction::JumpToEvent("ev_42")));
    }

    #[test]
    fn unknown_ids_are_ignored() {
        assert_eq!(route("undo"), None);
        assert_eq!(route(""), None);
    }

    #[test]
    fn fixed_items_reach_the_events_the_frontend_listens_for() {
        use MenuAction::*;
        let expected = [
            ("about", EmitToFocused("show-about")),
            ("find", EmitToFocused("menu-find")),
            ("settings", OpenSettings),
            ("new-window", NewWindow),
            ("session-picker", EmitToFocused("menu-session-picker")),
            ("session-import-file", EmitToFocused("menu-session-import-file")),
            ("session-play", EmitToFocused("menu-session-play")),
            ("session-pause", EmitToFocused("menu-session-pause")),
            ("session-stop", EmitToFocused("menu-session-stop")),
            ("session-detach", EmitToFocused("menu-session-detach")),
            ("session-stop-all", EmitToFocused("menu-session-stop-all")),
            ("session-clear", EmitToFocused("menu-session-clear")),
            ("event-add", EmitToFocused("menu-event-add")),
            ("event-show", OpenPanel("events")),
            ("help-issues", OpenUrl("https://github.com/Wired-Square/WireTAP/issues")),
            ("help-wiki", OpenUrl("https://github.com/Wired-Square/WireTAP/wiki")),
            ("help-source", OpenUrl("https://github.com/Wired-Square/WireTAP")),
        ];
        for (id, action) in expected {
            assert_eq!(route(id), Some(action), "{id}");
        }
    }
}
