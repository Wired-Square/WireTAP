// ui/src/hooks/useSessionCatalog.ts
//
// Shared catalogue load/attach wiring for session-bound apps (Decoder, Dashboard).
// Splits catalogue handling into two effects:
//   1. Mirror — track the session's catalogPath into local state (parse-free).
//   2. Load/attach — from a single parse, load the UI model and (when a session
//      exists) bind Rust decode via `catalog.attach`, falling back to a model-
//      only load if attach fails.
// Keeping the mirror effect parse-free is what avoids the old double parse.

import { useEffect } from "react";
import { tlog } from "../api/settings";

interface UseSessionCatalogOpts {
  /** Log label, e.g. "Decoder" / "Dashboard". */
  label: string;
  sessionId: string | undefined;
  /** The app store's active catalogue path. */
  catalogPath: string | null;
  /** The session's catalogue path (drives cross-app sync). */
  sessionCatalogPath: string | null | undefined;
  loadCatalog: (path: string) => Promise<void>;
  loadCatalogForSession: (sessionId: string, path: string) => Promise<void>;
  setCatalogPath: (path: string | null) => void;
}

export function useSessionCatalog({
  label,
  sessionId,
  catalogPath,
  sessionCatalogPath,
  loadCatalog,
  loadCatalogForSession,
  setCatalogPath,
}: UseSessionCatalogOpts): void {
  // Mirror the session's (Rust-authoritative) catalogPath into local state, one-way.
  // The load/attach effect does the parse — keeping this parse-free avoids a double
  // parse. Nothing writes `catalogPath` back, so this converges to the session path.
  useEffect(() => {
    if (!sessionCatalogPath || sessionCatalogPath === catalogPath) return;
    tlog.verbose(`[${label}] session decoder changed externally → ${sessionCatalogPath}`);
    setCatalogPath(sessionCatalogPath);
  }, [label, sessionCatalogPath, catalogPath, setCatalogPath]);

  // Load the model and — when a session exists — bind Rust decode, from a single
  // parse: catalog.attach returns the resolved catalogue.
  useEffect(() => {
    if (!catalogPath) return;
    // Bind only what the session has settled on. Until its decoder is decided,
    // `catalogPath` still holds the *previous* source's — and because every attach
    // writes Rust's authoritative path, which returns through the roster into the
    // mirror above, binding it makes the two values chase each other (a decoder
    // visibly flickering between the old catalogue and the right one).
    if (sessionId && sessionCatalogPath !== catalogPath) return;
    const run = sessionId
      ? loadCatalogForSession(sessionId, catalogPath)
      : loadCatalog(catalogPath);
    run.catch((e) => tlog.debug(`[${label}] catalog load/attach failed: ${e}`));
  }, [label, sessionId, catalogPath, sessionCatalogPath, loadCatalogForSession, loadCatalog]);
}
