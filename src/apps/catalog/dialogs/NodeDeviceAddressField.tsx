// ui/src/apps/catalog/dialogs/NodeDeviceAddressField.tsx
// Shared device-address input for the add/edit node dialogs (Modbus slaves).

import { Input, FormField } from "../../../components/forms";
import { caption } from "../../../styles";

export type NodeDeviceAddressFieldProps = {
  /** Only Modbus catalogues attribute a device address to a node. */
  show?: boolean;
  value?: number;
  onChange?: (v: number | undefined) => void;
};

export default function NodeDeviceAddressField({ show, value, onChange }: NodeDeviceAddressFieldProps) {
  if (!show) return null;
  return (
    <FormField label="Device Address" variant="default">
      <Input
        variant="default"
        type="number"
        min={1}
        max={247}
        value={value ?? ""}
        onChange={(e) => {
          const n = parseInt(e.target.value, 10);
          onChange?.(Number.isNaN(n) ? undefined : n);
        }}
        placeholder="1"
      />
      <p className={`mt-2 ${caption}`}>Modbus slave address (1-247) this node is polled at.</p>
    </FormField>
  );
}
