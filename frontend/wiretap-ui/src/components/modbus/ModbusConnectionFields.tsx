// ui/src/components/modbus/ModbusConnectionFields.tsx
//
// Where to point a Modbus scan.
//
// The target is chosen here rather than taken from a live session: pick a saved
// profile, or type an address. A sweep opens its own connection and takes the
// view over to show the results, so it runs from "No source" — which means
// there is no session to read a device off, and the profile list is what stands
// in for one.
//
// It starts on **Custom** — a blank host, with the port and unit at their
// protocol defaults — rather than seeding the first profile in the list, which
// would aim a sweep at a device nobody chose. Picking a profile prefills the
// fields and leaves them editable, which is also how you reach a second slave
// behind a gateway you only have one profile for.

import { useTranslation } from "react-i18next";
import { NumberField, SelectField, TextField, FieldRow } from "./ModbusFields";
import { MODBUS_SCAN_BOUNDS } from "./modbusScanDefaults";
import type { ModbusTarget } from "./useModbusTarget";
import { MODBUS_DEFAULT_CONNECTION } from "../../utils/modbusProfiles";

type Props = {
  target: ModbusTarget;
  /** Hide the unit field where the scan sweeps unit ids itself. */
  showUnitId?: boolean;
};

export default function ModbusConnectionFields({ target, showUnitId = true }: Props) {
  const { t } = useTranslation("discovery");
  const { profiles, profileId, connection, setConnection, selectProfile } = target;

  return (
    <div className="space-y-3">
      {profiles.length > 0 && (
        <SelectField
          label={t("modbusConnection.profile")}
          value={profileId ?? ""}
          onChange={(id) => selectProfile(id || null)}
          options={[
            { value: "", label: t("modbusConnection.custom") },
            ...profiles.map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
      )}

      <FieldRow>
        <TextField
          label={t("modbusConnection.host")}
          value={connection.host}
          onChange={(host) => setConnection({ ...connection, host })}
          placeholder={MODBUS_DEFAULT_CONNECTION.host}
        />
        <NumberField
          label={t("modbusConnection.port")}
          value={connection.port}
          onChange={(port) => setConnection({ ...connection, port })}
          min={MODBUS_SCAN_BOUNDS.port.min}
          max={MODBUS_SCAN_BOUNDS.port.max}
        />
        {showUnitId && (
          <NumberField
            label={t("modbusConnection.unitId")}
            value={connection.unit_id}
            onChange={(unit_id) => setConnection({ ...connection, unit_id })}
            min={MODBUS_SCAN_BOUNDS.unitId.min}
            max={MODBUS_SCAN_BOUNDS.unitId.max}
          />
        )}
      </FieldRow>
    </div>
  );
}
