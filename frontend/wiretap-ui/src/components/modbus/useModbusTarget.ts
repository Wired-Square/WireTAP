// ui/src/components/modbus/useModbusTarget.ts

import { useCallback } from "react";
import { useDiscoveryToolboxStore } from "../../stores/discoveryToolboxStore";
import {
  MODBUS_BLANK_CONNECTION,
  modbusConnectionOf,
  useModbusProfiles,
  type ModbusConnection,
} from "../../utils/modbusProfiles";

/**
 * The address a Modbus tool points at: picked from a profile, or typed.
 *
 * The tools run with no source selected, so there is never a session to take an
 * address from. Starts on **Custom** — a blank host with the protocol's own port
 * and unit — and picking a profile fills the fields in without locking them, so
 * a slave behind a gateway you have one profile for is still reachable.
 *
 * The address lives in the toolbox store beside every other tool's options,
 * because the panels are mounted by the active tool and unmounted when the
 * dialog closes: per-panel state would lose it on each switch, and switching is
 * the whole point of probe → unit scan → register sweep.
 */
export function useModbusTarget() {
  // Reactive, not a `getState()` snapshot: this feeds `name`, which is rendered,
  // and it is the same list the fields component draws its dropdown from.
  const profiles = useModbusProfiles();
  const { profileId, connection } = useDiscoveryToolboxStore((s) => s.toolbox.modbusTarget);
  const updateModbusTarget = useDiscoveryToolboxStore((s) => s.updateModbusTarget);

  const setConnection = useCallback(
    (next: ModbusConnection) => updateModbusTarget({ connection: next }),
    [updateModbusTarget]
  );

  /**
   * Selecting a profile refills the fields; they stay editable afterwards.
   * Selecting **Custom** clears the host — there is no device to name — but keeps
   * the port and unit.
   */
  const selectProfile = useCallback(
    (id: string | null) => {
      const profile = id ? profiles.find((p) => p.id === id) : undefined;
      updateModbusTarget({
        profileId: id,
        connection: profile ? modbusConnectionOf(profile) : MODBUS_BLANK_CONNECTION,
      });
    },
    [profiles, updateModbusTarget]
  );

  return {
    profiles,
    profileId,
    connection,
    setConnection,
    selectProfile,
    /** What to call the device on screen: the profile's name, else its address. */
    name: profiles.find((p) => p.id === profileId)?.name ?? `${connection.host}:${connection.port}`,
    /**
     * Whether there is a device to talk to. Custom starts with no host, so every
     * tool checks before offering to run — an empty host reaches Rust as a
     * connection failure, which is a worse way to learn a field was left blank.
     */
    hasAddress: connection.host.trim().length > 0,
  };
}

/** The whole target, so a panel forwards one prop rather than re-listing four. */
export type ModbusTarget = ReturnType<typeof useModbusTarget>;
