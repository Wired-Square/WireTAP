// ui/src/apps/catalog/dialogs/AddNodeDialog.tsx

import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Input, Textarea, FormField, SecondaryButton, PrimaryButton } from "../../../components/forms";
import { caption } from "../../../styles";
import NodeDeviceAddressField from "./NodeDeviceAddressField";

export type AddNodeDialogProps = {
  open: boolean;

  nodeName: string;
  setNodeName: (v: string) => void;

  nodeNotes: string;
  setNodeNotes: (v: string) => void;

  /** Modbus catalogues: a node owns a device (slave) address. */
  showDeviceAddress?: boolean;
  deviceAddress?: number;
  setDeviceAddress?: (v: number | undefined) => void;

  onCancel: () => void;
  onAdd: () => void;
};

export default function AddNodeDialog({
  open,
  nodeName,
  setNodeName,
  nodeNotes,
  setNodeNotes,
  showDeviceAddress,
  deviceAddress,
  setDeviceAddress,
  onCancel,
  onAdd,
}: AddNodeDialogProps) {
  return (
    <Dialog isOpen={open} title="Add Node">
      <DialogBody className="space-y-4">
        <FormField label="Node Name" required variant="default">
          <Input
            size="lg"
            value={nodeName}
            onChange={(e) => setNodeName(e.target.value)}
            placeholder="inverter, battery, etc."
            onKeyDown={(e) => {
              if (e.key === "Enter" && nodeName.trim()) {
                onAdd();
              }
            }}
          />
          <p className={`mt-2 ${caption}`}>
            Enter a descriptive name for this node (e.g., "inverter", "battery", "motor")
          </p>
        </FormField>

        <NodeDeviceAddressField
          show={showDeviceAddress}
          value={deviceAddress}
          onChange={setDeviceAddress}
        />

        <FormField label="Notes" variant="default">
          <Textarea
            size="lg"
            value={nodeNotes}
            onChange={(e) => setNodeNotes(e.target.value)}
            placeholder="Optional notes about this node..."
            rows={2}
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <SecondaryButton onClick={onCancel}>Cancel</SecondaryButton>
        <PrimaryButton onClick={onAdd} disabled={!nodeName.trim()}>
          Add Node
        </PrimaryButton>
      </DialogFooter>
    </Dialog>
  );
}
