// ui/src/apps/transmit/screens/TransmitScreen.tsx
//
// Screen wrapper for the Transmit app that handles window persistence.

import { useWindowPersistence } from "../../../hooks/useWindowPersistence";
import Transmit from "../Transmit";

export default function TransmitScreen() {
  // Handle window geometry persistence
  useWindowPersistence("transmit");

  return <Transmit />;
}
