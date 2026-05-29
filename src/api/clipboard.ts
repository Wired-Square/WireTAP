// Native clipboard via the Tauri plugin. Using navigator.clipboard.readText()
// in the macOS WKWebView triggers the OS paste-authorisation dialog on every
// paste; the native path does not. Single import point for all call sites.
export {
  readText as readClipboardText,
  writeText as writeClipboardText,
} from "@tauri-apps/plugin-clipboard-manager";
