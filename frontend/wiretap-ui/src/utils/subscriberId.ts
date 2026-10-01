import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";

// Deterministic per-(window, app) subscriber/instance id. There is exactly one
// instance of each session-aware app per window, so `${windowLabel}_${appName}` is
// globally unique. It MUST match the id MainLayout registers from Dockview's panel
// lifecycle (see registerOpenApp there) so an open panel and its session
// attachment are the same open-app-registry entry — that lets the Session Manager
// graph show open-but-unattached apps (even tabs Dockview hasn't mounted yet).
export function subscriberIdFor(appName: string): string {
  return `${getCurrentWebviewWindow().label}_${appName}`;
}
