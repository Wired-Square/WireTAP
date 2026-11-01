// src/apps/session-manager/utils/graphConnections.ts

import type { ActiveSessionInfo } from "../../../api/io";

export type GraphConnection =
  | { kind: "bus"; profileId: string; sessionId: string; deviceBus: number; outputBus: number; reenable: boolean }
  | { kind: "app"; sessionId: string; instanceId: string };

const busOf = (port: string | undefined, prefix: string) => {
  const match = port?.match(new RegExp(`^${prefix}-bus(\\d+)$`));
  return match ? parseInt(match[1], 10) : undefined;
};

/** What a drag from `source` to `target` would make, or `undefined` when the graph refuses it. */
export function resolveConnection(
  sessions: readonly ActiveSessionInfo[],
  source: string,
  sourcePort: string | undefined,
  target: string,
  targetPort: string | undefined,
): GraphConnection | undefined {
  if (source.startsWith("source-") && target.startsWith("session-")) {
    const profileId = source.slice("source-".length);
    const sessionId = target.slice("session-".length);
    const deviceBus = busOf(sourcePort, "out");
    const outputBus = busOf(targetPort, "in");
    if (deviceBus === undefined || outputBus === undefined) return undefined;

    const configs = sessions.find((s) => s.session_id === sessionId)?.broker_configs ?? [];
    const config = configs.find((c) => c.profile_id === profileId);
    if (!config) return undefined;
    // Two streams on one output bus merge indistinguishably, and Rust's transmit
    // routing gives the bus to whichever was added last.
    const outputBusTaken = configs.some((c) => c.bus_mappings.some((m) => m.enabled && m.output_bus === outputBus));
    if (outputBusTaken) return undefined;

    const reenable = config.bus_mappings.some((m) => m.device_bus === deviceBus && m.output_bus === outputBus);
    return { kind: "bus", profileId, sessionId, deviceBus, outputBus, reenable };
  }

  // An unconnected app's node is `app::<instanceId>`; a connected one's also names its session.
  const instanceId = target.startsWith("app::") ? target.slice("app::".length) : undefined;
  if (source.startsWith("session-") && instanceId && !instanceId.includes("::")) {
    return { kind: "app", sessionId: source.slice("session-".length), instanceId };
  }
  return undefined;
}
