# Changelog

All notable changes to CANdor will be documented in this file.

## [Unreleased]

### Added

- **Session Manager App**: New visual session management app with Node-RED style interface showing IO sessions as interactive nodes. Features include:
  - Source nodes (left): IO profiles feeding sessions, colour-coded by type (purple for realtime, green for recorded)
  - Session nodes (centre): Show session state (running/stopped/paused), listener count, buffer info, and device type
  - Listener nodes (right): Apps connected to each session
  - Animated edges showing active data flow between sources, sessions, and listeners
  - Pan/zoom canvas with minimap and controls
  - Detail panel showing selected node info with session control actions (start/stop/pause/destroy)
  - Auto-refresh with 2-second interval (toggleable)
  - Available from the dashboard launcher and logo menu
- **Stopped Sessions Now Joinable**: Sessions in "stopped" state now appear in the IO picker's Active Sessions list. Previously only "running" or "starting" sessions were shown. Stopped sessions display an amber "Stopped" badge instead of the green "Live" badge.
- **Query App in Dashboard Launcher**: Query app now appears in the dashboard launcher screen alongside other apps. Added global launcher button styles (`launcherButton`, `launcherButtonLabel`, `launcherGrid`) in `buttonStyles.ts` for consistent, responsive app launcher buttons.
- **Buffer-First Frame Display**: Discovery app now uses a buffer-first approach for frame display, improving UI responsiveness with large frame counts. Features include:
  - Backend tail fetch API (`get_buffer_frames_tail`) for efficient latest-N-frames retrieval
  - `useBufferFrameView` hook provides unified interface for streaming (tail poll) and stopped (pagination) modes
  - Eliminates large frontend frame arrays that caused O(n) useMemo iterations on every batch
  - Seamless transition between streaming and pagination without complex mode switching
- **Query App Default Catalog**: Query app now auto-loads the starred/default catalog on mount, matching the behaviour of Decoder and CatalogEditor. Centralised catalog path resolution into shared `catalogUtils.ts` utility.
- **Catalog Extended ID and CAN FD Defaults**: Catalog-level defaults for extended CAN IDs (29-bit) and CAN FD frames. Features include:
  - `default_extended` in `[meta.can]` section (default: false = 11-bit standard IDs)
  - `default_fd` in `[meta.can]` section (default: false = classic CAN)
  - Frame-level `extended` and `fd` overrides that inherit from catalog defaults
  - Auto-detection of extended IDs from frame ID value (> 0x7FF) when no default is set
  - CAN Config View displays new defaults
  - CAN Frame View shows Extended ID and CAN FD cards with "(inherited)" badges
  - Query app auto-populates Extended ID toggle when selecting frames from catalog
- **Query App (WIP)**: New app for querying PostgreSQL data sources to answer analytical questions about CAN bus history. This is a first attempt at the feature. Features include:
  - Tab-based UI with Query, Queue, and Results tabs
  - Byte change tracking: find when specific bytes in a frame changed value
  - Frame change detection: find when any byte in a frame changed
  - Configurable context window for ingesting frames around detected events
  - "Connect" mode in IO picker for database-only sessions (no streaming until ingest)
  - PostgreSQL protocol badge showing connection status
  - Results can be clicked to ingest surrounding frames into other apps (Decoder, Discovery)
  - Session system integration allows sharing ingested data with other apps
  - **Query Queue**: Sequential query execution with status indicators (pending, running, completed, error). Multiple queries can be queued and run automatically one after another. Queue items can be deleted (running queries are cancelled on the database server).
  - **Query Result Limit**: Configurable maximum results per query (100-100,000). Default can be set in Settings → General, with per-query override in the Query Builder.
  - **SQL Preview**: Read-only SQL query preview at the bottom of Query Builder for debugging and copying queries.
  - **Paginated Results**: Results panel now supports pagination with configurable page sizes (50, 100, 250, 500, 1000, or All).
  - **Frame ID Formatting**: Frame IDs displayed with leading zeros (3 digits for standard, 8 for extended frames).
  - **Frame Change Details**: Frame change results now show which byte indices changed (e.g., "bytes 0, 3, 7") instead of just the count.
  - **Time Bounds from Favourites**: Queries can be bounded to a saved favourite's time range for focused analysis.
- **Reusable TimeBoundsInput Component**: New unified component for time bounds input with optional bookmark pre-fill. Features include:
  - Bookmark dropdown that pre-fills start time, end time, and max frames fields
  - Timezone toggle (local/UTC) with automatic time conversion
  - All fields remain editable after bookmark selection
  - Dropdown retains bookmark name until fields are manually modified
  - `showBookmarks` prop to hide dropdown where bookmark selection doesn't apply
  - Used in Query app (QueryBuilderPanel), IO Reader Picker (IngestOptions), BookmarkEditorDialog, AddBookmarkDialog, and Settings bookmark dialogs (EditBookmarkDialog, CreateBookmarkDialog)
  - **Mirror Validation Query**: Compare mirror frames against their source frames to find timestamp mismatches. Supports catalog-based mirror frame selection (shows source frame info) or manual frame ID entry. Results show side-by-side payload comparison with mismatched bytes highlighted.
  - **Catalog Integration**: When a decoder catalog is selected, query builder shows frame/signal pickers instead of manual ID entry. Signal selection auto-populates byte index for byte change queries.
  - **Query Cancellation**: Running queries can be cancelled by removing them from the queue. Sends PostgreSQL cancel request to terminate the query on the server.
  - **Running Query Status**: Session status logging now shows running database queries with type, profile, and elapsed time.
  - **Stats Tab**: New Statistics/Maintenance tab showing database activity. View running queries on the database with ability to cancel them. View connected sessions with ability to terminate. Auto-refresh options (5s, 10s, 30s) for monitoring long-running queries.
- **Serial Max Frame Length**: Catalog-level `max_frame_length` setting for serial protocols. Acts as a safety limit for malformed framing (default: 64 bytes). Configurable in Settings → Serial Protocol.
- **candor-server Application Name**: PostgreSQL connections from candor-server now identify as "candor-server" in pg_stat_activity, making them easier to identify in the Query app Stats tab.
- **candor-server Disk Cache**: SQLite-based disk cache for PostgreSQL outage resilience. When the database is unavailable, frames are cached locally and recovered when connectivity is restored. Features include:
  - Automatic fallback to disk when PostgreSQL connection fails
  - Strict temporal ordering: cached frames drain completely before new frames
  - Graceful shutdown: remaining queue flushes to disk if DB unavailable
  - Startup recovery: detects and drains cached frames from previous sessions
  - Configurable cache path (`--pg-cache-path`, `PG_CACHE_PATH` env, or TOML `cache_path`)
  - Configurable max size (`--pg-cache-max-mb`, default 1GB)
  - Cache metrics in stats output: `cached=N cache_recovered=N cache_pending=N`
  - Auto-cleanup: cache file deleted after successful drain
  - Proactive queue overflow protection: flush queue to disk at configurable threshold (`--pg-queue-flush-pct`, default 50%) to prevent frame loss during cache recovery
- **Session Reconfiguration for Bookmark Jumps**: PostgreSQL sessions now stay alive when jumping between bookmarks. When an app changes time range via bookmark, the session reconfigures in-place rather than being destroyed and recreated. Benefits include:
  - Other apps joined to the session remain connected and receive the new frames
  - Old buffers are finalised and orphaned; new buffers created for the new time range
  - All apps clear their state and reset frame counts when any app reconfigures the session
  - New `session-reconfigured` event notifies listeners of time range changes
  - New `reconfigure_reader_session` Tauri command and `reconfigureReaderSession` API

### Changed

- **Discovery Error Dialog Migration**: Discovery app now uses the global error dialog (`appErrorDialog` in `sessionStore`) instead of its own local error state. This consolidates error handling across all apps and removes duplicate `ErrorDialog` render from Discovery.
- **IO Picker Buffer Section**: Renamed "Orphaned Buffers" to "Buffers" in the IO Reader Picker dialog for clarity.
- **Buffer Naming**: Buffers are now named after their session ID (e.g., "postgres_5a5282") instead of device-specific descriptions (e.g., "PostgreSQL 10.0.50.1:5432/candor"). The IO picker displays buffers as "Frames: {session_id}" or "Bytes: {session_id}".
- **Serial Frame Editor**: Simplified per-frame settings - removed encoding display (already set at catalog level) and max_length (moved to catalog level)
- **Catalog Editor**: Renamed "Endianness" to "Byte Order" in UI labels for consistency
- **Query App Extended Filter**: The `extended` filter is now optional. When no catalog is selected, queries search both standard and extended frames by default. Check the "Extended" checkbox to filter for extended frames only. When a catalog is selected, the extended setting from the catalog is used.
- **PostgreSQL Schema**: Added composite index `(id, extended, ts DESC)` on `can_frame` table for efficient filtering when extended is specified
- **candor-server Code Style**: Fixed pylint warnings including line length, import order, and added docstrings. Score improved from 8.39 to 9.03.

### Fixed

- **IO Picker Controls After Detach**: Fixed IO picker showing "Rejoin" button and "Multi-Bus" indicator after detaching from a session with a buffer copy. The session shape now distinguishes between:
  - **Play**: Actively streaming, appending to buffer
  - **Stop**: Session alive, buffer finalised but owned by session
  - **Detach (with buffer)**: App receives buffer COPY, leaves session, views standalone buffer (no session relationship, no "Rejoin" option)
  - **Detach (no buffer)**: App in "detached" state, can rejoin the session

  When an app detaches and receives a buffer copy, the controls now correctly show the buffer instead of session-related actions. Changes include:
  - `handleDetach` now explicitly sets `isDetached=false` when detaching with a buffer
  - `detachWithBufferCopy` now clears `multiBusMode` and `multiBusProfiles` state
  - `ReaderButton` now prioritises buffer display over multi-bus indicators
- **Discovery Cross-App Buffer Loading**: Fixed Discovery automatically loading buffers from other apps' sessions (e.g., Decoder streaming would populate Discovery's frame list). The `BUFFER_CHANGED` listener now checks buffer ownership and only processes buffers belonging to Discovery's current session or orphaned buffers.
- **Menu Session Picker Opens in All Windows**: Fixed session picker dialog opening in all windows when the same app (e.g., Discovery) was open in multiple windows. Now only the focused window responds to menu commands. Added `windowLabel` to session-control events to scope them to the originating window.
- **Query App Menu Integration**: Query app now responds to the Select Source menu command (Cmd+I) to open the IO picker.
- **Session Buffers Not Orphaned on Destroy**: Fixed buffers disappearing when sessions were destroyed. Buffers owned by a session are now orphaned (ownership cleared) when the session is destroyed, making them available for replay in the IO picker's Buffers section.
- **Serial Frame ID Validation**: Frame identifiers now accept hex values (`0xFDE2`), decimal numbers, and standard identifiers. Previously only alphanumeric identifiers starting with a letter were allowed.
- **PostgreSQL Query Serialization**: Fixed boolean and timestamp parameter serialization errors in database queries by using explicit type casts
- **Query App Results Tab Crash**: Fixed infinite re-render loop when clicking Results tab with no results. Changed from setState-during-render pattern to useEffect for page reset on query change.

## [0.3.2] - 2026-01-31

### Added

- **Mirror Frames in Catalog Editor**: CAN frames can now reference a primary frame using `mirror_of` to inherit all signals. Mirror signals override primary signals by bit position, allowing exact duplicates or frames with minor signal differences (e.g., Sungrow protocol). Features include:
  - Purple Layers icon in tree view for mirror frames
  - Mirror badge in selection header
  - "Mirror Of" input field in CAN config (mutually exclusive with "Copy From")
  - Inherited signals shown with Layers icon indicator in frame view
  - Byte layout visualisation with signal colours
  - DBC export generates complete signal definitions for each mirror frame
- **Mirror Frame Validation in Decoder**: Live validation comparing inherited signal bytes between mirror frames and their source frames. Features include:
  - Frame-level validation badge (Match/Mismatch/Pending) on mirror frame cards
  - Per-signal validation indicators showing which inherited signals match or mismatch
  - Dynamic fuzz window based on frame interval (2× the frame's interval or default_interval)
  - Hysteresis to prevent flickering (requires 3 consecutive mismatches before showing Mismatch)
  - Support for multiple mirrors referencing the same source frame
  - Wire timestamps used for accurate timing comparison
- **Global Theme System**: User-configurable theme mode (System/Light/Dark) in Settings → Display. The theme applies globally across all windows and apps, replacing the previous per-app dark mode forcing. System mode follows the OS preference and updates automatically when the OS theme changes.
- **Customisable Theme Colours**: User-configurable colour scheme via CSS custom properties. Settings → Display now includes colour pickers for light mode, dark mode, and accent colours. Changes apply instantly across all windows without restart. Includes "Reset to Defaults" to restore the original colour scheme.
- **Apps Menu**: New menu bar item with keyboard shortcuts to open apps as tabs in the focused window:
  - Discovery (⌘1), Decoder (⌘2), Transmit (⌘3), Catalog Editor (⌘4), Calculator (⌘5), Settings (⌘,)
  - Settings is a singleton — opening it from any window focuses the existing instance if one is already open
  - Apps open as Dockview tabs rather than separate windows
- **Session Menu**: New menu bar item for controlling IO sessions with focused-panel awareness:
  - Source info item showing the current profile name (disabled, displays "No source selected" when empty)
  - Select Source (⌘I) opens the IO picker dialog for the focused app
  - Playback controls: Play (⌘↵), Pause (⌘.), Stop (⌘⇧.) - control frame delivery for the focused app
  - Session controls: Detach Session (disconnect from shared session), Stop Session (stop for all apps)
  - Clear Frames (⌘K) clears the focused app's frame buffer
  - Menu items dynamically enable/disable based on session state and capabilities (e.g., Pause disabled for realtime sources)
  - Controls target the focused panel (Decoder, Discovery, or Transmit) rather than a global session
- **Bookmarks Menu**: New menu bar item for managing time range bookmarks:
  - Save Bookmark (⌘D) opens the bookmark dialog in Discovery with the current time
  - Manage Bookmarks opens Settings and navigates to the Bookmarks tab
  - Jump to Bookmark submenu shows available bookmarks for the focused app's IO profile
- **Jump to Bookmark While Streaming**: Bookmarks can now be loaded while a session is actively streaming. The session manager automatically stops the current stream, clears app state, and reinitializes with the bookmark's time range. The bookmark button in the toolbar is no longer disabled during streaming. Current playback speed is preserved when jumping to a bookmark.
- **Manual Bookmark Creation**: Bookmarks can now be created manually with custom start/end times:
  - New "+" button in the Bookmarks dialog header to create bookmarks from any window
  - New "New Bookmark" button in Settings → Bookmarks tab
  - Profile selector dropdown (filtered to time-range capable profiles like PostgreSQL)
  - Full datetime input fields for specifying custom time ranges
  - Clickable timezone badge to switch between Default, Local, and UTC timezones
- **Transmit Queue Recovery**: Transmit queue items now survive session disconnect/reconnect cycles:
  - Sessions with queued messages are preserved (marked as disconnected) instead of being deleted
  - Queue items automatically work again when the same profile reconnects
  - Visual warning indicator (amber alert icon) shows when a queue item's session is disconnected
  - New "link" button to reassign orphaned queue items to the currently active session
  - Replaced the Interface column with an editable Bus dropdown for CAN items
  - Replaced the enable/disable cogwheel icon with a simpler checkbox
  - Group play button now appears on the first enabled item, so groups remain controllable when items are disabled
- **Meaningful Bus Labels in Transmit**: The Bus column in Queue and History tabs now shows the source profile name instead of generic "Multi-Bus (2 sources)" when in multi-bus mode. Format is `outputBus: ProfileName` (e.g., "0: Sungrow Goulburn"), making it clear which physical interface each frame is transmitted through.

### Changed

- **Global Error Dialog Expansion**: Refactored error handling to use the global error dialog consistently across the app:
  - Renamed `showIOError` → `showAppError` (and related: `ioErrorDialog` → `appErrorDialog`, `useIOErrorDialog` → `useAppErrorDialog`) to reflect broader usage beyond IO errors
  - Replaced 4 native `alert()` calls in IO profile handlers with styled error dialogs
  - Added user-facing error dialogs for previously silent failures in: selection set picker, bookmark editor, Decoder session/catalog handlers, and Transmit session handlers
  - All errors now show consistently styled dialogs with title, message, and technical details

- **Dead Code Cleanup**: Removed unused code across the frontend codebase:
  - Deleted unused selector hook files (`useDecoderSelectors.ts`, `useDiscoverySelectors.ts`)
  - Removed unused utility functions from `windows.ts`, `persistence.ts`, `favorites.ts`, `selectionSets.ts`, and `serialFramer.ts`
  - Migrated 7 component files from deprecated style tokens to their modern equivalents (`bgDarkView` → `bgDataView`, etc.)
  - Removed 15 deprecated legacy aliases from `colourTokens.ts`

- **Unified Sidebar Styling**: Consolidated visual appearance of Settings sidebar (`AppSideBar`) and Catalog Editor sidebar (`ResizableSidebar`). Both now use the same header pattern with `PanelLeft`/`PanelLeftClose` icons, matching collapsed width (56px), and identical styling tokens (`bgPrimary`, `borderDefault`, `hoverLight`, `textSecondary`).
- **Comprehensive CSS Variable Migration**: Replaced ~1,100 Tailwind `dark:` variant patterns across 116 files with CSS custom properties for Windows WebView compatibility:
  - **Style tokens**: `typography.ts`, `colourTokens.ts`, `buttonStyles.ts`, `inputStyles.ts`, `badgeStyles.ts`, `cardStyles.ts` - all migrated to CSS variables
  - **Candor.css**: Added 60+ CSS variables including status colours (success, danger, warning, info, purple with bg/text/border variants), data accent colours (green, purple, orange, cyan, amber, yellow, red, blue), tertiary backgrounds, accent backgrounds, and semantic aliases
  - **IO reader picker**: All dialogs (`ReaderList`, `BufferList`, `ActionButtons`, `GvretBusConfig`, `SingleBusConfig`, `FramingOptions`, `FilterOptions`) now use CSS variables for selection states, borders, and status colours
  - **Catalog views**: All frame/signal/node/mux views and dialogs migrated
  - **Discovery tools**: Analysis panels and result views (`ChangesResultView`, `MessageOrderResultView`, `SerialAnalysisResultView`) migrated
  - **Settings**: All views and components including `IOProfileDialog`, `LocationsView`, `CatalogsView`, `BookmarksView`
  - **Shared components**: `TimeController`, `TimelineScrubber`, `HeaderFieldFilter`, `MaskBitPicker`, `ByteBits`, `FramingOptionsPanel`
- **Removed Theme Prop from Layout Components**: `AppLayout` and `AppTopBar` no longer accept a `theme` prop. All apps now follow the global theme setting instead of forcing dark mode individually.
- **Catalog Editor Sidebar Layout**: Action buttons (+node, +frame, filter) and protocol badges now stay fixed at the top while the tree scrolls independently. When the sidebar is collapsed, the +node and +frame buttons remain visible as icon-only buttons.
- **Decoder Toolbar Cleanup**: Removed the "rows per page" dropdown from Decoder's toolbar. Decoder shows all selected frames with their decoded signals and doesn't use pagination, so the dropdown was non-functional.

### Fixed

- **Settings Panel Fails to Open on Windows Startup**: Fixed Settings panel not responding to clicks immediately after launching the app on Windows. On startup, `is_focused()` returns false for all windows due to a WebView2 timing issue. Added fallback to the dashboard window when no focused window is found.
- **About Dialog Opening on All Windows**: Fixed the About dialog appearing on every open window when triggered from the menu. Now uses targeted event emission (`emit_to`) to show the dialog only on the focused window.
- **Tab Dragging in Secondary Windows on Windows**: Fixed Dockview tab dragging not working in secondary windows (main-1, main-2, etc.) on Windows. Dynamically created windows were missing the `disable_drag_drop_handler()` call that the dashboard window has via `dragDropEnabled: false` in tauri.conf.json. Without this, Tauri's native file drag-drop handler intercepts HTML5 drag events, breaking Dockview's tab reordering.
- **Decoder Memory Leak in Long Sessions**: Fixed unbounded memory growth in the Decoder that could cause WebView OOM and blank UI during long CAN monitoring sessions. The `decoded`, `decodedPerSource`, and `seenHeaderFieldValues` maps now use LRU eviction to cap memory usage at ~1-2MB regardless of session length. Limits: 500 decoded frames, 2000 per-source entries, 256 header field values per field.
- **Catalog Editor Sidebar Resize Lag**: Fixed significant lag when resizing the sidebar by disabling the CSS width transition during active drag operations. The smooth transition now only applies when collapsing/expanding the sidebar.
- **Missing Favourites After Store Migration**: Fixed time range bookmarks and selection sets not appearing after the multi-window store manager migration. The previous commit changed the storage file and key names (`favorites.dat`/`timeRangeFavorites` → `ui-state.json`/`favorites.timeRanges`) without migrating existing data. Added automatic migration on app startup that detects old store files and transfers data to the new format.

- **Dark Mode Styling on Windows WebView**: Fixed widespread dark mode styling issues on Windows where Tailwind `dark:` variants in style token string constants weren't being applied. Windows WebView doesn't detect system dark mode, so classes defined in `.ts` files weren't being generated by Tailwind JIT. Migrated all style tokens to CSS custom properties with fallback defaults in `Candor.css` for both light and dark modes. This affects Settings, Catalog Editor, dialogs, forms, buttons, badges, and all other components using centralised style tokens.
- **Discovery Time Display Contrast**: Fixed low contrast time text in Discovery's data view header in light mode. The `TimeDisplay` component now uses CSS variables for both compact and full-size modes, ensuring proper contrast in both themes.
- **Decoder Signal Row Styling**: Fixed bright white alternating rows in Decoder's signal list on dark mode (Windows). Added `--table-row-alt` and `--table-row-highlight` CSS variables for alternating table rows and change flash effects. Light mode now shows a subtle blue flash (`#dbeafe`) when signal values change, providing visible feedback that was previously invisible.
- **Catalog Editor Mirror Frame Case Sensitivity**: Fixed `mirror_of` and `copy` lookups requiring exact case match for hex frame IDs. Now `mirror_of = "0x1a5"` correctly matches a frame defined as `[frame.can.0x1A5]` by comparing numeric values instead of string keys.
- **Bookmark Max Frames Not Applied**: Fixed bookmark `maxFrames` limit not being applied when loading bookmarks. Discovery and Decoder now pass the bookmark's `maxFrames` to `reinitialize` so the frame limit is honoured when fetching data from time-range sources like PostgreSQL. Also fixed the IO picker dialog not populating the Max Frames field when selecting a bookmark.
- **Session Errors Not Displayed in Decoder**: Fixed IO session errors (e.g., "Access is denied" when SLCAN port is unavailable) not being shown to the user in Decoder. Errors were logged to console but not displayed. The root cause was a race condition: errors emitted before frontend listeners registered were silently dropped. Fixed by storing startup errors in Rust backend and returning them when the first listener registers. Centralised error handling in `sessionStore` now shows a global error dialog for session errors across all apps (Decoder, Discovery, Transmit).
- **Decoder Unmatched/Filtered Tabs Dark on Light Theme (Windows)**: Fixed hardcoded dark theme colours (`bg-gray-800`, `text-gray-*`) in Decoder Unmatched/Filtered tabs, Discovery serial dialogs, toggle buttons, and style utilities that ignored the user's theme on Windows. Replaced with CSS variable tokens (`bgDataView`, `textDataPrimary`, `textMuted`, etc.) for proper light/dark mode support.
- **Decoder Badge Colours on Windows Light Mode**: Fixed hardcoded dark-mode colours in Decoder badges ("Mirror of", "Match/Mismatch", header field badges) that had poor contrast on Windows in light mode. The "Dark Panel Badges" in `badgeStyles.ts` used fixed Tailwind colours (`text-blue-400`, `text-cyan-400`, etc.) designed for dark backgrounds. Replaced with CSS variables (`--status-info-*`, `--status-success-*`, `--status-cyan-*`, `--status-purple-*`) that adapt to the current theme.
- **Blurry Text on Windows**: Fixed blurry/fuzzy text rendering on Windows. Added `SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)` call at startup to enable proper Per-Monitor V2 DPI awareness for WebView2. Also changed font stack to use system fonts (Segoe UI on Windows, San Francisco on macOS) for optimal platform-native rendering.
- **Discovery Infinite Loop After PostgreSQL Session End**: Fixed "Maximum update depth exceeded" React error when ending a PostgreSQL session after changing bookmarks. The buffer fetch effect was triggering when `bufferMetadata` became null (due to buffer deletion) but buffer mode was still enabled, causing repeated fetch attempts on a non-existent buffer. Added guard to only fetch when a valid buffer ID exists.
- **Buffer Switch During Bookmark Jump**: Fixed a race condition where jumping to a bookmark while streaming could cause the PostgreSQL session to be destroyed before it started. The buffer-switching effect in Discovery now uses `streamEndedReason === "complete"` instead of `stoppedExplicitly` to determine when to switch to buffer mode, ensuring explicit stops (like bookmark jumps) don't trigger unwanted buffer switches.
- **Discovery Playback Controls Missing for PostgreSQL Sessions**: Fixed playback controls (play/pause/step buttons) not appearing in Discovery's toolbar during PostgreSQL ingest sessions. The `PlaybackControls` component's `isReady` prop was tied to buffer mode, but PostgreSQL direct ingest doesn't use buffer mode. Now shows controls when `isRecorded` is true. Also fixed the frame counter showing "/ 0" when the total frame count is unknown.
- **Decoder "No catalog" on Windows with Favourite Decoder**: Fixed the Decoder toolbar showing "No catalog" on Windows even when a favourite decoder was loaded and signals were displayed. The path comparison used to find the selected catalog in the list failed on Windows because Rust returns paths with backslashes (`C:\Users\...`) while the frontend constructs paths with forward slashes. Normalised path separators before comparing. Also fixed the same issue in Catalog Editor.

## [0.3.1] - 2026-01-30

### Changed

- **Standardised App Layout Components**: Created reusable layout components (`AppLayout`, `AppTopBar`, `AppSideBar`) for consistent app structure across all panels. `AppLayout` provides the outer container with theme support (auto or always-dark). `AppTopBar` is a unified top bar with configurable IO session controls, frame picker, and action slots. `AppSideBar` is a collapsible sidebar with icon-only mode when collapsed. All apps (Discovery, Decoder, Transmit, Settings, Catalog Editor, Calculator) now use the "bubble" pattern - content wrapped in a rounded border container. Refactored individual TopBar components (DiscoveryTopBar, DecoderTopBar, TransmitTopBar, CatalogToolbar) to use `AppTopBar` internally. Deleted redundant SettingsTopBar and SettingsSidebar files.

- **Centralised Style Tokens**: Consolidated inline Tailwind classes into reusable style tokens for consistency and maintainability. Typography tokens: `labelSmall`, `sectionHeader`, `caption`, `textMedium`, `captionMuted`, `sectionHeaderText`. Layout tokens: `bgSecondary`, `bgSurface`, `borderDivider`, `hoverLight`, `focusRing`. Button tokens: `iconButtonHover`, `iconButtonHoverCompact`, `iconButtonHoverSmall`, `secondaryButton`, `folderPickerButton`, `dialogOptionButton`. Card tokens: `expandableRowContainer`, `selectableOptionBox`. Badge tokens: `badgeMetadata`. Applied across 100+ files including IO reader picker dialogs, catalog views, settings views, analysis result views, form components, and shared UI components.

### Fixed

- **Dead Code Warnings on Windows**: Silenced spurious compiler warnings for unused config structs (`GvretUsbConfig`, `SlcanConfig`), serde default functions, and the `store_manager::flush` function. These are intentional API surface preserved for future use or serialization.

- **Multi-Window Blank Screen on Windows**: Fixed issue where opening a second window via View → New Window would show a blank white screen on Windows. Two issues caused this: (1) The `tauri-plugin-store` file locking mechanism caused windows to hang waiting for exclusive file access. Replaced the frontend-side tauri-plugin-store with a centralised Rust-side store manager that all windows access via IPC. The store manager caches data in memory, handles concurrent access, and persists changes with debounced atomic writes. (2) Synchronous window creation in `create_main_window` blocked the Tauri command response, deadlocking when the UI thread was needed. Made the command async and spawned window creation via `run_on_main_thread()` so the command returns immediately.
- **Low Contrast Text on Windows**: Improved text contrast throughout dark data views (Discovery, Decoder, Transmit). Changed `textDarkSubtle` from `text-gray-500` to `text-gray-400`, `textDarkMuted` from `text-gray-400` to `text-gray-300`, fixed TimeDisplay to use explicit light colours in compact mode, and updated Decoder's frame headers, signal timestamps, and empty state messages to use appropriate gray levels. Also converted Discovery and Decoder top bars from `dark:` Tailwind variants to explicit dark colour tokens (`bgDarkToolbar`, `borderDarkView`) for consistent rendering. Added new colour tokens `textDarkDecorative` and `textDarkPlaceholder` for standardised styling. Windows WebView doesn't properly detect system dark mode, causing `dark:` variants to fall back to light mode colours.
- **IO Picker Buffer Selection in Multi-Bus Mode**: Fixed buffer checkmark incorrectly appearing when readers are selected in multi-bus mode. The BufferList now checks both single-select (`checkedReaderId`) and multi-select (`checkedReaderIds`) state to determine if a buffer is truly selected.
- **gs_usb Serial Number Device Matching**: gs_usb profiles now use USB serial numbers as the primary device identifier instead of bus:address. USB device addresses are dynamically assigned by Windows and can change on device reset or reconnect. Serial numbers are stable identifiers that persist across reconnections, preventing "device not found" errors when addresses change. Profiles store the serial number when a device is selected; existing profiles continue to work via bus:address fallback.

## [0.3.0] - 2026-01-29

### Added

- **SocketCAN Optional Interface Configuration** (Linux): SocketCAN profiles now support optional bitrate configuration. When a bitrate is selected, CANdor automatically configures the interface using `pkexec` (polkit) for privilege escalation, running `ip link set` commands to bring down the interface, set the bitrate, and bring it back up. When no bitrate is set, the interface is used as already configured by the system. This eliminates the need for manual terminal commands in most cases while preserving flexibility for pre-configured setups.
- **Buffer Frame Stepping**: Step forward and backward through buffer frames one at a time using the step buttons in the playback controls. Stepping respects the current frame ID filter, skipping to the next/previous frame that matches. Step buttons are disabled at buffer boundaries (start/end).
- **Current Frame Highlighting**: During buffer playback or stepping, the current frame is highlighted in the frame table with a cyan ring. The view automatically scrolls to keep the highlighted frame visible.
- **Frame Index Display**: Hovering over a frame row shows "Frame N" in the tooltip, indicating its position in the buffer. Clicking a row selects that frame and seeks to its timestamp.
- **GVRET Interface Configuration**: GVRET profiles (TCP and USB) now support per-interface configuration in Settings. After saving a profile, click "Probe Device" to detect available interfaces. Each interface can be enabled/disabled and configured for CAN or CAN FD protocol. The backend reads this configuration when creating sessions, using the correct protocol traits for each bus. Profiles without interface configuration continue to work with a single default bus for backward compatibility.
- **Interface-Level Trait System**: Formalised traits at the interface level with validation. Each interface (bus mapping) now has explicit traits: `TemporalMode` (realtime/timeline), `Protocol` (can/canfd/modbus/serial), `can_transmit`, and a human-readable `interface_id` (e.g., "can0", "serial1"). Sessions validate trait compatibility when combining multiple interfaces - temporal modes must match, timeline sessions are limited to 1 interface, and protocols must be compatible (CAN + CAN-FD OK, but not CAN + Serial). This enables future support for devices with mixed interface types (e.g., 2 CAN + 2 Serial interfaces).
- **Serial Multi-Bus Support**: Serial interfaces can now be combined in multi-bus sessions alongside other serial ports. Supports full framing (SLIP, Modbus RTU, delimiter-based) with raw bytes visible in the Bytes tab when using Raw framing mode.
- **SocketCAN CAN FD Support** (Linux): SocketCAN interfaces now support CAN FD frames with payloads up to 64 bytes. The backend automatically detects FD frames and sets `is_fd: true`. Transmission of FD frames with BRS (bit rate switch) is also supported.

### Fixed

- **gs_usb Safe Byte Parsing**: Replaced all unsafe `transmute` and `read_unaligned` calls in the gs_usb driver with safe `from_bytes()` constructors. The `GsHostFrame` and `GsDeviceConfig` structs now provide safe parsing methods that validate buffer length before constructing values from little-endian bytes.
- **Mutex Poisoning Handling**: Replaced `.lock().unwrap()` calls in slcan and serial readers with proper error propagation. Init closures return errors, transmit loops send error responses to callers, and read loops emit stream-ended events before breaking. Prevents panic propagation when a mutex is poisoned.
- **gs_usb Codec Error Handling**: Replaced `.try_into().unwrap()` in gs_usb codec with `.map_err()` + `?`, properly propagating byte slice conversion errors instead of panicking.
- **Serial Task Panic Recovery**: Added stream-ended emission after `spawn_blocking` panic in serial reader. If the blocking read task panics, the session now correctly emits a stream-ended event so the frontend can recover.
- **Multi-Source Stop Panic Logging**: Added logging when tasks panic during multi-source reader shutdown, aiding debugging of unexpected task failures.
- **slcan Line Buffer Truncation Logging**: Added logging when slcan line buffer exceeds 64 bytes and is discarded, helping diagnose protocol framing issues.
- **Stale Closure in Profile Reinitialise**: Fixed stale `effectiveProfileName` closure in `useIOSession` when switching profiles. The reinitialise function now uses the provided `newProfileId` parameter when available, ensuring the correct profile name is used.
- **Watch Session Error Handling**: Added try/catch to `handleDialogStartIngest` in Discovery, matching the error handling pattern used in multi-source watch. Errors now display in a dialog instead of being silently swallowed.
- **Watch Frame Count Reset**: Fixed watch frame count not resetting to zero when a stream ends. The `resetWatchFrameCount()` function is now called when `isStreaming` transitions to false while watching.

- **Serial Frame ID Extraction for Multi-Source Sessions**: Fixed frame ID extraction not working for serial sources in multi-bus sessions. The frame ID config from the catalog (`[meta.serial.fields.id]` mask) was not being passed through the multi-source session chain. Now the catalog's frame ID extraction settings (start_byte, num_bytes, byte_order) are properly passed from the frontend through `useIOSessionManager` to the Rust backend's multi-source spawner. Additionally fixed two related issues: (1) stale closure issue where changing the catalog after selecting an IO reader would not update the session handlers - `serialConfig` is now read directly from the store via `getState()` at call time; (2) loading a catalog while streaming now works seamlessly - the frontend extracts frame IDs directly from raw bytes using the catalog config, so no session restart is needed.
- **Signal Edit Dialog Validation**: Fixed "Update Signal" button not working in the Catalog Editor. Integer fields (`start_bit`, `bit_length`) were failing `Number.isInteger()` validation when values came through as strings from TOML parsing. Added type coercion in validation, form handlers, and input handlers.
- **String Signal Bit Length Limit**: Increased maximum `bit_length` for string format signals (UTF-8, ASCII, hex) from 64 to 2048 bits (256 bytes), allowing longer string signals like VIN numbers to be defined.
- **BitPreview Infinite Render Loop**: Fixed "Maximum update depth exceeded" error in the Signal Edit Dialog's bit preview. The `onColorMapping` callback was causing an infinite loop because inline functions passed from parent components created new references on every render. Now uses a ref to store the callback, breaking the dependency cycle.
- **GVRET Probe Default Bus Count**: Fixed GVRET device probing defaulting to 5 buses when the device doesn't respond to the NUMBUSES query. Now defaults to 1 bus, which is safer for single-bus devices.
- **Decoder Frame Matching on Session Start**: Fixed issue where starting an IO session from the Decoder would cause frames to never match the catalog. The `clearFrames` function was incorrectly clearing the catalog frame definitions along with session data. Now only session/buffer data is cleared, preserving the loaded catalog.
- **Multi-Window Session ID Collision**: Fixed potential session ID collision when multiple windows of the same app type (e.g., two Decoder windows) start multi-bus sessions. Session IDs are now generated dynamically using the pattern `{protocol}_{shortId}` (e.g., `can_a7f3c9`) instead of the fixed `{appName}-multi` pattern. Single-bus devices (gs_usb, slcan, etc.) now properly include interface traits in their bus mappings, enabling accurate protocol detection for session naming.
- **IO Reader Picker Selection Conflict**: Fixed issue where selecting a GVRET interface then a serial interface would cause the serial interface to probe forever. The dialog now clears multi-bus selection (`checkedReaderIds`) when selecting a single profile, ensuring mutual exclusivity between single-select and multi-select modes.

### Changed

- **Release Script Changelog Validation**: The release script (`scripts/release.js`) now validates the changelog before releasing. It checks for either a version-specific section (e.g., `## [0.2.34]`) or an `[Unreleased]` section with content. If an `[Unreleased]` section exists, it's automatically renamed to the new version with today's date. The script displays the changelog content for review and prompts for confirmation before proceeding.
- **Deduplicated Buffer Profile Detection**: Consolidated duplicate `isBufferProfileId()` implementations into a single canonical function in `sessionStore.ts`. The function now accepts `string | null` and is re-exported from `useIOSessionManager` for backward compatibility.
- **Removed Unused Rust Method**: Deleted `IOCapabilities::get_data_streams()` which was never called. The frontend's `getDataStreams()` helper handles this logic.

- **Simplified Playback State**: Consolidated "stopped" and "paused" into a single "paused" state. The stop button now behaves identically to pause, simplifying the playback state machine. Both show the square icon and allow stepping through frames.
- **IO Reader Picker Release Button**: The Release button is now positioned inline with action buttons (Watch, Ingest, Join Session, etc.) instead of appearing in a separate row above them. This provides a more compact layout.
- **IO Module Refactoring**: Internal code organisation improvements including unified `TransmitRequest` type, consolidated GVRET probe logic via shared `parse_numbuses_response()` helper, and new `traits.rs`/`types.rs` modules for better separation of concerns.
- **Structured IO Errors**: Replaced string-based IO errors with a typed `IoError` enum. Error variants include Connection, Timeout, Protocol, Transmission, Configuration, DeviceNotFound, DeviceBusy, Read, and Other. All drivers (gvret_tcp, gvret_usb, slcan, socketcan, gs_usb) now use structured errors with device context for better diagnostics. Backwards compatible via `From<IoError> for String`.
- **IO Driver Directory Structure**: Reorganised IO drivers into directory-based modules. Each driver (gvret, slcan, socketcan, gs_usb, serial, mqtt, timeline) is now a directory containing `mod.rs`, `codec.rs` (where applicable), and implementation files. Added unified `FrameCodec` trait in `io/codec.rs` for consistent encode/decode operations across all protocols.
- **Multi-Source Reader Modularisation**: Split `multi_source.rs` (1,112 lines) into a directory-based module with focused submodules: `types.rs` (SourceConfig, TransmitRoute), `merge.rs` (frame merging and event emission), `spawner.rs` (per-protocol reader spawning), and `mod.rs` (MultiSourceReader struct and IODevice implementation).
- **Serial Profile Parsing Extraction**: Moved serial IOProfile parsing from `multi_source/spawner.rs` into `serial/utils.rs` as `parse_profile_for_source()`. This keeps serial-specific configuration logic in the serial module and reduces spawner.rs from 469 to 260 lines.
- **Centralised Session Switching in useIOSessionManager**: Moved session switching orchestration (profile selection, multi-bus state, watch lifecycle, playback speed) from per-app handler hooks into `useIOSessionManager`. New manager methods: `watchSingleSource`, `watchMultiSource`, `stopWatch`, `selectProfile`, `selectMultipleProfiles`, `joinSession`, `skipReader`. Apps provide callbacks (`onBeforeWatch`, `onBeforeMultiWatch`, `setPlaybackSpeed`) for app-specific cleanup. Deleted dead `useIOSessionHandlers.ts` and renamed `useBufferSessionHandler` to `useBufferSession` for naming consistency.
- **First-Class Bytes and Frames Session Model**: Refactored session architecture to treat byte streams (serial) and frame streams (CAN) as peer data types instead of CAN-centric with serial bolted on. Key changes:
  - Renamed `can-bytes-error` event to `session-error` across all emitters and listeners — the event was never CAN-specific.
  - Moved `emit_stream_ended()` from `gvret/common.rs` to shared `io/mod.rs`, eliminating the duplicate in `serial/reader.rs`. All drivers now import from the shared location.
  - Renamed `SourceMessage::RawBytes` to `SourceMessage::Bytes` and `RawByteEntry` to `ByteEntry`. Aligned `timestamp_us` to `u64` (was `i64`), removing a cast in merge.rs.
  - Added `SessionDataStreams { emits_frames, emits_bytes }` to `IOCapabilities` — each device formally declares what data streams it produces. Multi-source derives streams from constituents. Frontend helper `getDataStreams()` provides legacy fallback.
  - Routed raw bytes through `sessionStore` via new `onBytes` callback in `SessionCallbacks`, eliminating the ad-hoc `listen()` in Discovery.tsx. Bytes now go through the same centralised event listener and callback routing system as frames.
  - Unified `transmit_frame()` and `transmit_serial()` into a single `transmit(payload: TransmitPayload)` method on `IODevice`, where `TransmitPayload` is `CanFrame(CanTransmitFrame) | RawBytes(Vec<u8>)`. Adding new transport types (Modbus write, SPI) no longer requires new trait methods.
  - Relaxed protocol group isolation in `traits.rs` — removed `protocol_group()` function. Any protocol combination is now valid in multi-source sessions as long as temporal modes match (e.g., CAN + serial debug port). `SessionDataStreams` handles the distinction.

## [0.2.33] - 2026-01-24

### Added

- **Multi-Window Support**: Open multiple CANdor windows via View → New Window (Cmd+N). Each window maintains its own independent tab layout.
- **Per-Window Tab Persistence**: Each window remembers its open tabs and layout. Tabs are restored when the window reopens.
- **Window State Persistence**: Window size and position are automatically saved and restored on relaunch.
- **Session Restore**: All open windows are restored when relaunching CANdor, each with their saved tabs, size, and position.
- **Timezone Display Setting**: New "Default timezone" option in Settings → Display allows choosing between Local and UTC for clock displays. Clock displays in Decoder and Discovery now show a clickable badge (Local/UTC) that cycles through timezone options without changing the global setting.
- **Date Display for Recorded Sources**: Clock displays now show both date and time when viewing recorded data (PostgreSQL, CSV, buffers), while live sources show time only.
- **Second-Precision Bookmarks**: Bookmark time inputs now support second-level precision. Previously bookmarks were limited to minute granularity.
- **Session Joining for Recorded Sources**: Active PostgreSQL sessions now appear in the IO Reader Picker's "Active Sessions" section, allowing other apps (e.g., Decoder) to join an existing streaming session from Discovery. Previously only multi-bus sessions were shown as joinable.
- **Centralized Bookmark Button**: The bookmark picker button is now part of the session controls (next to play/stop) in Decoder and Discovery top bars. The button only appears when the data source supports time range filtering (e.g., PostgreSQL), and is disabled while streaming since time range cannot be changed mid-stream.
- **Discovery Speed Picker**: The playback speed button is now visible in the Discovery top bar when using recorded sources (PostgreSQL). Previously only available in Decoder.
- **Continue Without Reader**: IO Reader Picker dialog now shows a "Continue Without Reader" button when no reader is selected, allowing users to set up Transmit frames before connecting to a device.

### Fixed

- **Ingest Frame Count NaN**: Fixed "Ingesting: NaN frames" display in the IO Reader Picker dialog when ingesting from PostgreSQL and other sources using the new frame batch payload format. The frame message listener now handles both legacy array format and the newer `FrameBatchPayload` object format.
- **Panel Scroll Overflow**: Fixed app panels scrolling beyond their boundaries and going underneath the title bar on macOS. Root html/body elements now use `position: fixed` and `overscroll-behavior: none` to completely lock the webview in place. App components use `h-full` instead of `h-screen`, a centralized `PanelWrapper` ensures proper height constraints, and scroll containers use `overscroll-none`.
- **Decoder Unlimited Speed Playback**: Fixed issue where the Decoder would not show decoded signals when playing back from PostgreSQL at unlimited speed (0x). Frames are now flushed immediately when stream ends, ensuring all frames are processed before completion.
- **Second-Precision Bookmark Timestamps**: Fixed PostgreSQL queries failing when using bookmarks with second-precision timestamps. The timestamp format was being double-suffixed (e.g., `09:04:20:00` instead of `09:04:20`).
- **Watch Mode Playback Pacing**: Fixed IO Reader Picker defaulting to unlimited speed (0x) for Watch mode instead of 1x realtime. Watch now correctly defaults to 1x with pacing enabled, ensuring recorded data plays back at the intended speed.
- **IO Reader Picker Selection Stability**: Fixed data source selection being cleared when changing watch speed in the IO Reader Picker dialog. The issue was caused by a new empty array being created on each re-render, triggering the dialog's initialization effect.
- **Discovery Speed Picker Dialog**: Fixed speed picker in Discovery showing a "Change Speed Mode?" warning dialog instead of the speed picker. Discovery now uses the same SpeedPickerDialog as Decoder, with the confirmation dialog only appearing when switching from No Limit mode with frames present.
- **Cross-Window Speed Synchronization**: Fixed playback speed not syncing between windows when apps share a session. When Discovery changes speed while Decoder is viewing the same PostgreSQL session, Decoder's speed display now updates automatically. The backend now emits `speed-changed` events and apps subscribe via `onSpeedChange` callback.
- **Discovery Protocol Badge Case**: Fixed protocol badge showing lowercase "can" in Discovery. Now displays uppercase "CAN" to match Decoder.
- **Transmit Top Bar Styling**: Fixed Transmit icon color (blue→red) to match the tab icon, and added separator after icon for consistency with Decoder and Discovery.
- **Transmit Protocol Badge Label**: Fixed protocol badge losing its text when IO session is stopped. Now defaults to "CAN" or "Serial" based on the active tab when no session is connected.

### Changed

- **Shared Protocol Badge Component**: Extracted protocol badge (with status light, protocol label, recorded indicator) into reusable `ProtocolBadge` component. Now used consistently across Decoder, Discovery, and Transmit. The badge is clickable for future protocol configuration features.
- **Transmit View Styling**: Transmit now has the same dark-themed tab bar style as Decoder and Discovery, with a protocol badge showing streaming status and "CAN" or "Serial" label based on the connected device's capabilities.
- **Simplified View Menu**: The View menu now contains only "New Window" and "Enter Fullscreen". App shortcuts (Dashboard, Decoder, Discovery, etc.) have been removed in favor of using the logo menu within windows.
- **Centralized IO Session Management**: Added `useIOSessionManager` hook to consolidate common IO session patterns (profile state, multi-bus coordination, derived state, detach/rejoin handlers). Transmit app now uses this hook, reducing code duplication and establishing a pattern for incremental adoption by other apps.
- **Unified Session Architecture**: All real-time device sessions (GVRET, slcan, gs_usb, SocketCAN) now use the same internal `MultiSourceReader` path, even for single-device sessions. This simplifies the codebase by eliminating duplicate code paths (~500 lines) while maintaining the same external API. Single-device sessions are now implemented as multi-device sessions with n=1.
- **PostgreSQL No-Limit Batch Size**: Reduced from 1000 to 50 frames per batch to match frontend throttling thresholds, improving decoder responsiveness during fast playback.
- **Dialog State Management**: Added `useDialogManager` hook to consolidate multiple `useState` pairs for dialog visibility into a single hook call. Decoder and Discovery now use this hook, reducing boilerplate and providing a cleaner API (`dialogs.xxx.open()`, `dialogs.xxx.close()`, `dialogs.xxx.isOpen`).
- **Unified IO Session Controls**: Introduced `IOSessionControls` component that combines reader button, speed picker, bookmark button, and session action buttons (stop/resume/detach/rejoin) into a single reusable component. All three apps (Decoder, Discovery, Transmit) now use this unified component for consistent session control layout.
- **Removed No Limit Mode**: Removed the "No Limit" (0x) playback speed option from Discovery. This mode was intended for fast ingestion but added complexity. Users should now use the standard speed options (0.25x to 60x) for playback. The `PlaybackSpeed` type is now centralized in `TimeController` component.

## [0.2.32] - 2026-01-22

### Added

- **Serial Transmit**: Added support for transmitting raw bytes through serial port connections. The Serial tab in the Transmit app now supports:
  - Single-shot byte transmission with optional SLIP or delimiter framing
  - Repeat transmission from the queue at configurable intervals
  - Full history logging for transmitted bytes
- **Multi-Bus Capture**: Support for combining multiple real-time devices into a single merged session. Select multiple sources in the IO Reader Picker using the new "Multi-Bus" toggle. Each source can be configured with:
  - Per-bus enable/disable toggles to filter unwanted buses (for GVRET multi-bus devices)
  - Output bus remapping to assign unique bus numbers across devices
  - Auto-sequential bus number assignment when adding sources
  - Warning indicators when duplicate output bus numbers are configured
- **Unified Device Probing**: All real-time devices (GVRET, slcan, gs_usb, SocketCAN, Serial) are now probed when selected to confirm they're online and healthy. Shows device status and allows bus number configuration.
- **Single-Bus Device Configuration**: When selecting a single-bus device (slcan, gs_usb, etc.) in the IO Reader Picker, you can now configure the output bus number for multi-bus capture scenarios.
- **Multi-Bus Session Sharing**: Active multi-bus sessions now appear in the IO Reader Picker for other apps (e.g., Decoder) to join. When Discovery creates a multi-bus session, it's shown in the "Active Multi-Bus Sessions" section so other apps can receive the same merged frame stream.
- **Discovery Multi-Bus Indicator**: The Discovery top bar now shows "Multi-Bus (N)" with a merge icon when a multi-source session is active, replacing the previous "No reader" display.
- **Multi-Bus Transmit Support**: Transmit app now supports multi-bus sessions. When connected to a multi-bus session, frame transmission is routed to the appropriate source device based on the target bus number. Bus numbers are mapped back to the correct device bus for transmission.
- **Transmit History**: Repeat transmissions (individual and group) now appear in the Transmit History tab. Each frame sent during a repeat cycle is logged with timestamp, success/error status, and frame details.

### Fixed

- **Serial Reconnection**: Fixed issue where serial ports (slcan, serial) could not be reconnected after disconnecting. Two issues were addressed:
  1. Profile tracker not being cleaned up when sessions auto-destroyed via listener unregistration
  2. Transmit app's Stop button now properly leaves the session to release single-handle devices

### Changed

- **sbrxxx.toml**: Updated Sungrow decoder catalog to v3.
- **Transmit Default Interval**: Changed the default repeat transmit interval from 100ms to 1000ms.
- **Adaptive Frame Flushing**: Frame delivery now uses adaptive timing instead of fixed 100ms intervals. Frames are flushed when either 50 frames accumulate (for high-frequency buses) or after 50ms (for low-frequency data). This reduces latency for sparse data while maintaining UI performance under heavy load.
- **Dedicated Transmit Tasks**: GVRET TCP and gs_usb drivers now use dedicated transmit tasks that run independently of the read loop. This ensures consistent transmit timing regardless of incoming traffic volume, fixing issues where transmits could be delayed by 2+ seconds during heavy bus activity.
- **Improved Repeat Transmit Timing**: Repeat transmit now sends the first frame immediately and only starts the interval timer after the first successful transmission. Permanent errors (device disconnected, session not found) stop the repeat and notify the UI.
- **Transmit History Timestamps**: History tab now honors the display time format setting (human, timestamp, delta-start, delta-last) consistent with Discovery.
- **Transmit Bus Display**: Bus numbers in Transmit Queue and History views now show generic "Bus 0", "Bus 1" labels instead of GVRET-specific names, consistent with multi-bus mode where devices are mixed.

## [0.2.31] - 2026-01-15

### Fixed

- **64-bit Signal Decoding**: Fixed signals with bit_length > 32 being truncated due to JavaScript's 32-bit bitwise operator limitation. Now uses BigInt for extraction and formatting of large signals.

### Changed

- **sbrxxx.toml**: Updated Sungrow decoder catalog.
- **Release Script**: Now runs `cargo check` to update Cargo.lock before committing version bump.

## [0.2.30] - 2026-01-14

### Added

- **Update Checker**: App now checks for updates on launch and displays an amber indicator in the menu bar when a newer version is available. Clicking the indicator opens the GitHub release page.
- **gs_usb Support**: Added support for candleLight/CANable devices with gs_usb firmware on Windows, macOS, and Linux. On Linux, devices appear as SocketCAN interfaces; on Windows and macOS, direct USB access via nusb userspace driver. Supports all standard CAN bitrates (10K-1M).
- **MQTT Reader**: Added MQTT broker support for receiving CAN frames. Supports SavvyCAN JSON format with optional CAN FD. Configure host, port, credentials, and subscription topic in Settings.

### Fixed

- **gs_usb Device Selection**: Fixed device picker not updating when selecting a gs_usb device. The issue was caused by stale closures when multiple connection fields were updated in a single event handler.
- **gs_usb Categorization**: gs_usb profiles now correctly appear under "Real-time" in the Data Source picker instead of "Recorded".

## [0.2.29] - 2026-01-13

### Fixed

- **Decoder**: Fixed stale session restart when switching IO profiles. When switching from one GVRET endpoint to another, the old session was incorrectly being restarted due to a stale closure capturing the previous session ID. The Decoder now correctly relies on the backend's auto-start behavior after reinitializing a session.
