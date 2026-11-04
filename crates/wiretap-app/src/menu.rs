// Copyright 2026 Wired Square Pty Ltd

use std::collections::HashMap;
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

/// The menu bar's words in the user's language, supplied by the frontend.
#[derive(serde::Deserialize)]
#[cfg_attr(test, derive(ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct NativeMenuLabels {
    apps_menu: String,
    edit_menu: String,
    session_menu: String,
    events_menu: String,
    jump_to_event_menu: String,
    view_menu: String,
    help_menu: String,
    about: String,
    settings: String,
    new_window: String,
    find: String,
    no_source: String,
    /// The source line, with `{{name}}` where the profile name goes.
    source: String,
    session_picker: String,
    session_import_file: String,
    session_play: String,
    session_pause: String,
    session_stop: String,
    session_detach: String,
    session_stop_all: String,
    session_clear: String,
    event_add: String,
    event_show: String,
    help_issues: String,
    help_wiki: String,
    help_source: String,
    /// Apps menu labels by panel id; an app left out keeps its label.
    apps: HashMap<String, String>,
}

#[cfg(not(target_os = "ios"))]
const NAME_SLOT: &str = "{{name}}";

#[cfg(not(target_os = "ios"))]
impl NativeMenuLabels {
    /// What the menu says before the frontend has loaded.
    fn english() -> Self {
        let s = str::to_owned;
        Self {
            apps_menu: s("Apps"),
            edit_menu: s("Edit"),
            session_menu: s("Session"),
            events_menu: s("Events"),
            jump_to_event_menu: s("Jump to Event"),
            view_menu: s("View"),
            help_menu: s("Help"),
            about: s("About WireTAP"),
            settings: s("Settings\u{2026}"),
            new_window: s("New Window"),
            find: s("Find\u{2026}"),
            no_source: s("No source selected"),
            source: s("Source: {{name}}"),
            session_picker: s("Select Source\u{2026}"),
            session_import_file: s("Import from File\u{2026}"),
            session_play: s("Play"),
            session_pause: s("Pause"),
            session_stop: s("Stop"),
            session_detach: s("Detach Session"),
            session_stop_all: s("Stop Session"),
            session_clear: s("Clear Frames"),
            event_add: s("Add Event\u{2026}"),
            event_show: s("Show Events"),
            help_issues: s("Report an Issue\u{2026}"),
            help_wiki: s("Documentation\u{2026}"),
            help_source: s("Source Code\u{2026}"),
            apps: HashMap::new(),
        }
    }

    fn item(&self, id: ItemId) -> &str {
        match id {
            ItemId::About => &self.about,
            ItemId::Settings => &self.settings,
            ItemId::NewWindow => &self.new_window,
            ItemId::Find => &self.find,
            ItemId::SessionSource => &self.no_source,
            ItemId::SessionPicker => &self.session_picker,
            ItemId::SessionImportFile => &self.session_import_file,
            ItemId::SessionPlay => &self.session_play,
            ItemId::SessionPause => &self.session_pause,
            ItemId::SessionStop => &self.session_stop,
            ItemId::SessionDetach => &self.session_detach,
            ItemId::SessionStopAll => &self.session_stop_all,
            ItemId::SessionClear => &self.session_clear,
            ItemId::EventAdd => &self.event_add,
            ItemId::EventShow => &self.event_show,
            ItemId::HelpIssues => &self.help_issues,
            ItemId::HelpWiki => &self.help_wiki,
            ItemId::HelpSource => &self.help_source,
        }
    }

    fn title(&self, id: SubmenuId) -> &str {
        match id {
            SubmenuId::Apps => &self.apps_menu,
            SubmenuId::Edit => &self.edit_menu,
            SubmenuId::Session => &self.session_menu,
            SubmenuId::Events => &self.events_menu,
            SubmenuId::JumpToEvent => &self.jump_to_event_menu,
            SubmenuId::View => &self.view_menu,
            SubmenuId::Help => &self.help_menu,
        }
    }

    fn source_line(&self, profile_name: Option<&str>) -> String {
        match profile_name {
            Some(name) => self.source.replace(NAME_SLOT, name),
            None => self.no_source.clone(),
        }
    }

    /// The text for the menu entry `id`, or `None` for one these labels don't cover.
    fn text_for(&self, id: &str, profile_name: Option<&str>) -> Option<String> {
        if let Some(item) = ItemId::parse(id) {
            return Some(match item {
                ItemId::SessionSource => self.source_line(profile_name),
                _ => self.item(item).to_owned(),
            });
        }
        if let Some(submenu) = SubmenuId::parse(id) {
            return Some(self.title(submenu).to_owned());
        }
        id.strip_prefix(APP_PREFIX).and_then(|app| self.apps.get(app)).cloned()
    }
}

#[cfg(not(target_os = "ios"))]
pub(crate) struct MenuLabelState(Mutex<MenuLabels>);

#[cfg(not(target_os = "ios"))]
struct MenuLabels {
    labels: NativeMenuLabels,
    profile_name: Option<String>,
}

#[cfg(target_os = "ios")]
#[allow(dead_code)]
pub(crate) struct MenuLabelState(Mutex<()>);

#[cfg(not(target_os = "ios"))]
pub(crate) fn manage_state(builder: tauri::Builder<Wry>) -> tauri::Builder<Wry> {
    builder
        .manage(SessionMenuState(Mutex::new(None)))
        .manage(EventsMenuState(Mutex::new(None)))
        .manage(EventMenuItemState(Mutex::new(None)))
        .manage(MenuLabelState(Mutex::new(MenuLabels {
            labels: NativeMenuLabels::english(),
            profile_name: None,
        })))
}

#[cfg(target_os = "ios")]
pub(crate) fn manage_state(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    builder
        .manage(SessionMenuState(Mutex::new(())))
        .manage(EventsMenuState(Mutex::new(())))
        .manage(EventMenuItemState(Mutex::new(())))
        .manage(MenuLabelState(Mutex::new(())))
}

#[cfg(not(target_os = "ios"))]
macro_rules! menu_ids {
    ($name:ident { $($variant:ident = $id:literal),* $(,)? }) => {
        #[derive(Clone, Copy, PartialEq, Eq, Debug)]
        enum $name { $($variant),* }

        impl $name {
            #[cfg(test)]
            const ALL: &'static [$name] = &[$($name::$variant),*];

            fn as_str(self) -> &'static str {
                match self { $($name::$variant => $id),* }
            }

            fn parse(id: &str) -> Option<Self> {
                match id { $($id => Some($name::$variant),)* _ => None }
            }
        }
    };
}

#[cfg(not(target_os = "ios"))]
menu_ids! { ItemId {
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
}}

#[cfg(not(target_os = "ios"))]
menu_ids! { SubmenuId {
    Apps = "submenu-apps",
    Edit = "submenu-edit",
    Session = "submenu-session",
    Events = "submenu-events",
    JumpToEvent = "submenu-jump-to-event",
    View = "submenu-view",
    Help = "submenu-help",
}}

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
    fn item(self, labels: &NativeMenuLabels) -> MenuItemBuilder {
        MenuItemBuilder::with_id(self.as_str(), labels.item(self))
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
    label_state: State<MenuLabelState>,
    has_session: bool,
    profile_name: Option<String>,
    is_streaming: bool,
    is_paused: bool,
    can_pause: bool,
    joiner_count: u32,
    has_events: bool,
) {
    let source_line = {
        let mut current = label_state.0.lock().unwrap();
        current.profile_name = profile_name.filter(|_| has_session);
        current.labels.source_line(current.profile_name.as_deref())
    };
    if let Some(items) = state.0.lock().unwrap().as_ref() {
        let _ = items.source.set_text(&source_line);
        if has_session {
            let _ = items.play.set_enabled(!is_streaming || is_paused);
            let _ = items.pause.set_enabled(is_streaming && !is_paused && can_pause);
            let _ = items.stop.set_enabled(is_streaming && !is_paused && can_pause);
            let _ = items.detach.set_enabled(is_streaming && joiner_count > 1);
            let _ = items.stop_all.set_enabled(is_streaming);
            let _ = items.picker.set_enabled(true);
            let _ = items.clear.set_enabled(true);
        } else {
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
    _label_state: State<MenuLabelState>,
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

/// Relabel the menu bar in the frontend's language.
#[cfg(not(target_os = "ios"))]
#[tauri::command]
pub fn set_native_menu_labels(
    app: AppHandle,
    state: State<MenuLabelState>,
    labels: NativeMenuLabels,
) {
    let mut current = state.0.lock().unwrap();
    current.labels = labels;
    if let Some(menu) = app.menu() {
        relabel(menu.items().unwrap_or_default(), &|id| {
            current.labels.text_for(id, current.profile_name.as_deref())
        });
    }
}

#[cfg(not(target_os = "ios"))]
fn relabel(items: Vec<MenuItemKind<Wry>>, text_for: &impl Fn(&str) -> Option<String>) {
    for kind in items {
        match kind {
            MenuItemKind::MenuItem(item) => {
                if let Some(text) = text_for(item.id().as_ref()) {
                    let _ = item.set_text(text);
                }
            }
            MenuItemKind::Submenu(submenu) => {
                if let Some(text) = text_for(submenu.id().as_ref()) {
                    let _ = submenu.set_text(text);
                }
                relabel(submenu.items().unwrap_or_default(), text_for);
            }
            _ => {}
        }
    }
}

#[cfg(target_os = "ios")]
#[tauri::command]
pub fn set_native_menu_labels(_state: State<MenuLabelState>, _labels: NativeMenuLabels) {
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
    labels: &NativeMenuLabels,
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

    let mut builder = submenu(app, labels, SubmenuId::Apps);
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

#[cfg(not(target_os = "ios"))]
fn submenu<'m>(
    app: &'m tauri::App,
    labels: &NativeMenuLabels,
    id: SubmenuId,
) -> SubmenuBuilder<'m, Wry, tauri::App> {
    SubmenuBuilder::with_id(app, id.as_str(), labels.title(id))
}

/// Setup menus for desktop platforms (not available on iOS)
#[cfg(not(target_os = "ios"))]
pub(crate) fn setup_desktop_menus(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let labels = NativeMenuLabels::english();
    // Create About menu item (App submenu on macOS)
    let about_item = ItemId::About.item(&labels).build(app)?;
    let settings_item = ItemId::Settings.item(&labels)
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
    let apps_menu = build_apps_menu(app, &labels)?;

    // Create View menu items
    let new_window_item = ItemId::NewWindow.item(&labels)
        .accelerator("cmdOrCtrl+N")
        .build(app)?;

    // Edit menu - use predefined items for native clipboard/undo support
    let find_item = ItemId::Find.item(&labels)
        .accelerator("cmdOrCtrl+F")
        .build(app)?;

    let edit_menu = submenu(app, &labels, SubmenuId::Edit)
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
    let session_source_item = ItemId::SessionSource.item(&labels)
        .enabled(false)
        .build(app)?;
    let session_picker_item = ItemId::SessionPicker.item(&labels)
        .accelerator("cmdOrCtrl+I")
        .build(app)?;
    let session_import_item = ItemId::SessionImportFile.item(&labels)
        .accelerator("cmdOrCtrl+Shift+I")
        .build(app)?;

    // Playback controls (frame delivery)
    let session_play_item = ItemId::SessionPlay.item(&labels)
        .accelerator("cmdOrCtrl+Return")
        .build(app)?;
    let session_pause_item = ItemId::SessionPause.item(&labels)
        .accelerator("cmdOrCtrl+.")
        .build(app)?;
    let session_stop_item = ItemId::SessionStop.item(&labels)
        .accelerator("cmdOrCtrl+Shift+.")
        .build(app)?;

    // Session connection controls
    let session_detach_item = ItemId::SessionDetach.item(&labels)
        .enabled(false)
        .build(app)?;
    let session_stop_all_item = ItemId::SessionStopAll.item(&labels)
        .build(app)?;

    let session_clear_item = ItemId::SessionClear.item(&labels)
        .accelerator("cmdOrCtrl+K")
        .build(app)?;

    let session_menu = submenu(app, &labels, SubmenuId::Session)
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
    let event_add_item = ItemId::EventAdd.item(&labels)
        .accelerator("cmdOrCtrl+D")
        .build(app)?;
    let event_show_item = ItemId::EventShow.item(&labels).build(app)?;

    // Create "Jump to Event" submenu (dynamically populated by frontend)
    let jump_to_event_submenu = submenu(app, &labels, SubmenuId::JumpToEvent).build()?;

    let events_menu = submenu(app, &labels, SubmenuId::Events)
        .item(&event_add_item)
        .item(&jump_to_event_submenu)
        .separator()
        .item(&event_show_item)
        .build()?;

    // Create View submenu
    let view_menu = submenu(app, &labels, SubmenuId::View)
        .item(&new_window_item)
        .separator()
        .fullscreen()
        .build()?;

    // Create Help menu
    let help_issues_item = ItemId::HelpIssues.item(&labels).build(app)?;
    let help_wiki_item = ItemId::HelpWiki.item(&labels).build(app)?;
    let help_source_item = ItemId::HelpSource.item(&labels).build(app)?;

    let help_menu = submenu(app, &labels, SubmenuId::Help)
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
    fn no_submenu_id_collides_with_an_item_or_a_prefix() {
        for &id in SubmenuId::ALL {
            let id = id.as_str();
            assert_eq!(ItemId::parse(id), None, "{id}");
            assert_eq!(route(id), None, "{id}");
        }
    }

    #[test]
    fn every_fixed_item_and_submenu_takes_its_text_from_the_labels() {
        let labels = NativeMenuLabels::english();
        for &id in ItemId::ALL {
            assert!(!labels.text_for(id.as_str(), None).unwrap().is_empty(), "{id:?}");
        }
        for &id in SubmenuId::ALL {
            let text = labels.text_for(id.as_str(), None);
            assert_eq!(text.as_deref(), Some(labels.title(id)), "{id:?}");
        }
    }

    #[test]
    fn the_source_line_fills_the_name_slot_or_says_no_source() {
        let labels = NativeMenuLabels {
            source: "Quelle « {{name}} »".into(),
            ..NativeMenuLabels::english()
        };
        assert_eq!(labels.source_line(Some("GVRET")), "Quelle « GVRET »");
        assert_eq!(labels.source_line(None), "No source selected");
        assert_eq!(labels.text_for("session-source", Some("GVRET")).unwrap(), "Quelle « GVRET »");
    }

    #[test]
    fn an_app_takes_its_label_only_when_one_is_given() {
        let labels = NativeMenuLabels {
            apps: HashMap::from([("decoder".to_owned(), "Décodeur".to_owned())]),
            ..NativeMenuLabels::english()
        };
        assert_eq!(labels.text_for("app-decoder", None).as_deref(), Some("Décodeur"));
        assert_eq!(labels.text_for("app-discovery", None), None);
        assert_eq!(labels.text_for("event-jump-ev_1", None), None);
        assert_eq!(labels.text_for("undo", None), None);
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
