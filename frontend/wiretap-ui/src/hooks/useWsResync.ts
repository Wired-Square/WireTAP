// Shared primitive: reconcile derived state whenever the backend says it moved.
//
// The backend owns several rosters — the catalogue list, the open-app registry, the
// session roster — and broadcasts a global WebSocket message whenever one changes.
// Every consumer reconciles off the same three triggers: once on mount (so there is
// no startup race), on the push, and on reconnect (which catches changes missed while
// the socket was down).
//
// Extracted because the hooks doing this were byte-for-byte identical apart from the
// message type, and because `useCatalogSources` depends on reconciling on exactly the
// same triggers as `useCatalogList` — a rule that has to live in one place to be true.

import { useEffect, useRef } from "react";
import { wsTransport } from "../services/wsTransport";
import { MsgType } from "../services/wsProtocol";

/**
 * @param msgType The global push that means "this may have changed".
 * @param onSync Called once on mount, then on every push and on reconnect. Need not
 *   be stable — the latest one is always called.
 */
export function useWsResync(msgType: (typeof MsgType)[keyof typeof MsgType], onSync: () => void): void {
  // Held in a ref so an inline arrow does not re-subscribe (and re-sync) on every
  // render, and so callers are not silently required to memoise.
  const latest = useRef(onSync);
  latest.current = onSync;

  useEffect(() => {
    // A fresh closure per hook instance. `onReconnect` keeps listeners in a Set, so
    // registering a shared function reference (a Zustand action, say) would collapse
    // two consumers into one entry — and the first unmount would silently deregister
    // the survivor.
    const run = () => latest.current();
    run();
    const offChanged = wsTransport.onGlobalMessage(msgType, run);
    const offReconnect = wsTransport.onReconnect(run);
    return () => {
      offChanged();
      offReconnect();
    };
  }, [msgType]);
}
