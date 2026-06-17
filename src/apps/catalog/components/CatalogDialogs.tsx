// ui/src/apps/catalog/components/CatalogDialogs.tsx
// Consolidated dialog rendering for CatalogEditor

import { useCatalogEditorStore } from "../../../stores/catalogEditorStore";
import SignalEditDialog from "../dialogs/SignalEditDialog";
import MuxEditDialog from "../dialogs/MuxEditDialog";
import ChecksumEditDialog from "../dialogs/ChecksumEditDialog";
import UnsavedChangesDialog from "../../../dialogs/UnsavedChangesDialog";
import NewCatalogDialog from "../dialogs/NewCatalogDialog";
import AddMuxCaseDialog from "../dialogs/AddMuxCaseDialog";
import EditMuxCaseDialog from "../dialogs/EditMuxCaseDialog";
import AddNodeDialog from "../dialogs/AddNodeDialog";
import EditNodeDialog from "../dialogs/EditNodeDialog";
import ConfirmDeleteDialog from "../../../dialogs/ConfirmDeleteDialog";
import ExportCatalogDialog from "../dialogs/ExportCatalogDialog";
import ValidationErrorsDialog from "../dialogs/ValidationErrorsDialog";
import UnifiedConfigDialog from "../dialogs/UnifiedConfigDialog";
import type { TomlNode, ChecksumAlgorithm } from "../types";
import type { SignalFields, MuxFields } from "../hooks/useCatalogForms";
import type { CatalogHandlers } from "../hooks/useCatalogHandlers";

type Props = {
  // Signal editing
  editingSignal: boolean;
  currentIdForSignal: string | null;
  selectedNode: TomlNode | null;
  catalogContent: string;
  signalFields: SignalFields;
  setSignalFields: (fields: SignalFields) => void;
  editingSignalIndex: number | null;
  setEditingSignal: (v: boolean) => void;

  // Mux editing
  editingMux: boolean;
  currentMuxPath: string[];
  isAddingNestedMux: boolean;
  isEditingExistingMux: boolean;
  muxFields: MuxFields;
  setMuxFields: (fields: MuxFields) => void;
  setEditingMux: (v: boolean) => void;

  // Export dialog
  showExportDialog: boolean;
  setShowExportDialog: (v: boolean) => void;
  catalogPath: string | null;

  // Handlers
  handlers: CatalogHandlers;
};

export default function CatalogDialogs({
  editingSignal,
  currentIdForSignal,
  selectedNode,
  catalogContent,
  signalFields,
  setSignalFields,
  editingSignalIndex,
  setEditingSignal,
  editingMux,
  currentMuxPath,
  isAddingNestedMux,
  isEditingExistingMux,
  muxFields,
  setMuxFields,
  setEditingMux,
  showExportDialog,
  setShowExportDialog,
  catalogPath,
  handlers,
}: Props) {
  // Store selectors for dialog state
  const dialogs = useCatalogEditorStore((s) => s.ui.dialogs);
  const dialogPayload = useCatalogEditorStore((s) => s.ui.dialogPayload);
  const validationErrors = useCatalogEditorStore((s) => s.validation.errors);
  const validationIsValid = useCatalogEditorStore((s) => s.validation.isValid);
  const clearValidation = useCatalogEditorStore((s) => s.clearValidation);
  const closeDialog = useCatalogEditorStore((s) => s.closeDialog);
  const setDialogPayload = useCatalogEditorStore((s) => s.setDialogPayload);

  const metaFields = useCatalogEditorStore((s) => s.forms.meta);
  const setMetaFields = useCatalogEditorStore((s) => s.setMetaForm);
  const caseValue = useCatalogEditorStore((s) => s.forms.muxCaseValue);
  const setCaseValue = useCatalogEditorStore((s) => s.setMuxCaseValue);
  const caseNotes = useCatalogEditorStore((s) => s.forms.muxCaseNotes);
  const setCaseNotes = useCatalogEditorStore((s) => s.setMuxCaseNotes);
  const nodeName = useCatalogEditorStore((s) => s.forms.nodeName);
  const setNodeName = useCatalogEditorStore((s) => s.setNodeName);
  const nodeNotes = useCatalogEditorStore((s) => s.forms.nodeNotes);
  const setNodeNotes = useCatalogEditorStore((s) => s.setNodeNotes);
  const nodeDeviceAddress = useCatalogEditorStore((s) => s.forms.nodeDeviceAddress);
  const setNodeDeviceAddress = useCatalogEditorStore((s) => s.setNodeDeviceAddress);
  const hasModbusFrames = useCatalogEditorStore((s) => s.tree.hasModbusFrames);
  const hasModbusConfig = useCatalogEditorStore((s) => !!s.tree.modbusConfig);
  // A node owns a device (slave) address only in a Modbus catalogue.
  const showNodeDeviceAddress = hasModbusFrames || hasModbusConfig;
  const serialEncoding = useCatalogEditorStore((s) => s.forms.serialEncoding);
  const setSerialEncoding = useCatalogEditorStore((s) => s.setSerialEncoding);
  const modbusDeviceAddress = useCatalogEditorStore((s) => s.forms.modbusDeviceAddress);
  const setModbusDeviceAddress = useCatalogEditorStore((s) => s.setModbusDeviceAddress);
  const modbusRegisterBase = useCatalogEditorStore((s) => s.forms.modbusRegisterBase);
  const setModbusRegisterBase = useCatalogEditorStore((s) => s.setModbusRegisterBase);
  const canDefaultEndianness = useCatalogEditorStore((s) => s.forms.canDefaultEndianness);
  const setCanDefaultEndianness = useCatalogEditorStore((s) => s.setCanDefaultEndianness);
  const canDefaultInterval = useCatalogEditorStore((s) => s.forms.canDefaultInterval);
  const setCanDefaultInterval = useCatalogEditorStore((s) => s.setCanDefaultInterval);
  const serialByteOrder = useCatalogEditorStore((s) => s.forms.serialByteOrder);

  // Determine inherited byte order based on protocol type from path
  const inheritedByteOrder = (() => {
    if (!selectedNode?.path) return undefined;
    const protocol = selectedNode.path[1]; // path is ["frame", "can"|"serial"|"modbus", ...]
    if (protocol === "can") return canDefaultEndianness;
    if (protocol === "serial") return serialByteOrder;
    return undefined;
  })();

  return (
    <>
      <UnsavedChangesDialog
        isOpen={dialogs.unsavedChanges}
        onCancel={handlers.handleCancelLeave}
        onConfirmLeave={handlers.handleConfirmLeave}
      />

      <SignalEditDialog
        open={editingSignal && !!currentIdForSignal && !!selectedNode}
        selectedNode={selectedNode as TomlNode}
        catalogContent={catalogContent}
        fields={signalFields}
        setFields={setSignalFields}
        editingIndex={editingSignalIndex}
        inheritedByteOrder={inheritedByteOrder}
        onCancel={() => setEditingSignal(false)}
        onSave={handlers.handleSaveSignal}
      />

      <MuxEditDialog
        open={editingMux}
        catalogContent={catalogContent}
        currentMuxPath={currentMuxPath}
        isAddingNestedMux={isAddingNestedMux}
        isEditingExistingMux={isEditingExistingMux}
        fields={muxFields}
        setFields={setMuxFields}
        generateMuxName={handlers.generateMuxName}
        onCancel={() => setEditingMux(false)}
        onSave={handlers.handleSaveMux}
      />

      <AddMuxCaseDialog
        open={dialogs.addMuxCase}
        caseValue={caseValue}
        setCaseValue={setCaseValue}
        caseNotes={caseNotes}
        setCaseNotes={setCaseNotes}
        validationErrors={validationErrors}
        clearValidation={clearValidation}
        onCancel={() => {
          closeDialog("addMuxCase");
          setCaseNotes("");
          clearValidation();
        }}
        onAdd={handlers.handleSaveCase}
      />

      <EditMuxCaseDialog
        open={dialogs.editMuxCase}
        caseValue={caseValue}
        setCaseValue={setCaseValue}
        caseNotes={caseNotes}
        setCaseNotes={setCaseNotes}
        validationErrors={validationErrors}
        clearValidation={clearValidation}
        onCancel={() => {
          closeDialog("editMuxCase");
          setCaseValue("");
          setCaseNotes("");
          setDialogPayload({ editingCaseMuxPath: null, editingCaseOriginalValue: null });
          clearValidation();
        }}
        onSave={handlers.handleSaveEditCase}
      />

      <NewCatalogDialog
        open={dialogs.newCatalog}
        metaFields={metaFields}
        setMetaFields={setMetaFields}
        canDefaultEndianness={canDefaultEndianness}
        setCanDefaultEndianness={setCanDefaultEndianness}
        canDefaultInterval={canDefaultInterval}
        setCanDefaultInterval={setCanDefaultInterval}
        modbusDeviceAddress={modbusDeviceAddress}
        setModbusDeviceAddress={setModbusDeviceAddress}
        modbusRegisterBase={modbusRegisterBase}
        setModbusRegisterBase={setModbusRegisterBase}
        serialEncoding={serialEncoding}
        setSerialEncoding={setSerialEncoding}
        validationErrors={validationErrors}
        onCancel={() => closeDialog("newCatalog")}
        onCreate={handlers.handleCreateNewCatalog}
      />

      <AddNodeDialog
        open={dialogs.addNode}
        nodeName={nodeName}
        setNodeName={setNodeName}
        nodeNotes={nodeNotes}
        setNodeNotes={setNodeNotes}
        showDeviceAddress={showNodeDeviceAddress}
        deviceAddress={nodeDeviceAddress}
        setDeviceAddress={setNodeDeviceAddress}
        onCancel={() => {
          closeDialog("addNode");
          setNodeNotes("");
          setNodeDeviceAddress(undefined);
        }}
        onAdd={handlers.handleSaveNode}
      />

      <EditNodeDialog
        open={dialogs.editNode}
        nodeName={nodeName}
        setNodeName={setNodeName}
        nodeNotes={nodeNotes}
        setNodeNotes={setNodeNotes}
        showDeviceAddress={showNodeDeviceAddress}
        deviceAddress={nodeDeviceAddress}
        setDeviceAddress={setNodeDeviceAddress}
        validationErrors={validationErrors}
        clearValidation={clearValidation}
        onCancel={() => {
          closeDialog("editNode");
          setNodeName("");
          setNodeNotes("");
          setNodeDeviceAddress(undefined);
          setDialogPayload({ editingNodeOriginalName: null });
          clearValidation();
        }}
        onSave={handlers.handleSaveEditNode}
      />

      <ConfirmDeleteDialog
        open={dialogs.deleteCanFrame}
        title="Delete CAN Frame"
        message="Are you sure you want to delete CAN frame"
        highlightText={dialogPayload.idToDelete || undefined}
        onCancel={() => {
          closeDialog("deleteCanFrame");
          setDialogPayload({ idToDelete: null });
        }}
        onConfirm={handlers.handleConfirmDeleteId}
      />

      <ConfirmDeleteDialog
        open={dialogs.deleteSignal}
        title="Delete Signal"
        message="Are you sure you want to delete signal"
        highlightText={
          (dialogPayload.signalToDelete && dialogPayload.signalToDelete.name) || undefined
        }
        onCancel={() => {
          closeDialog("deleteSignal");
          setDialogPayload({ signalToDelete: null });
        }}
        onConfirm={handlers.confirmDeleteSignal}
      />

      <ConfirmDeleteDialog
        open={dialogs.deleteChecksum}
        title="Delete Checksum"
        message="Are you sure you want to delete checksum"
        highlightText={
          (dialogPayload.checksumToDelete && dialogPayload.checksumToDelete.name) || undefined
        }
        onCancel={() => {
          closeDialog("deleteChecksum");
          setDialogPayload({ checksumToDelete: null });
        }}
        onConfirm={handlers.confirmDeleteChecksum}
      />

      {dialogs.editChecksum && dialogPayload.checksumToEdit && (
        <ChecksumEditDialog
          open={dialogs.editChecksum}
          selectedNode={selectedNode as TomlNode}
          catalogContent={catalogContent}
          fields={{
            name: dialogPayload.checksumToEdit.checksum?.name || "",
            algorithm: (dialogPayload.checksumToEdit.checksum?.algorithm || "sum8") as ChecksumAlgorithm,
            start_byte: dialogPayload.checksumToEdit.checksum?.start_byte ?? 0,
            byte_length: dialogPayload.checksumToEdit.checksum?.byte_length ?? 1,
            endianness: dialogPayload.checksumToEdit.checksum?.endianness,
            calc_start_byte: dialogPayload.checksumToEdit.checksum?.calc_start_byte ?? 0,
            calc_end_byte: dialogPayload.checksumToEdit.checksum?.calc_end_byte ?? 1,
            notes: dialogPayload.checksumToEdit.checksum?.notes,
          }}
          setFields={(fields) => {
            setDialogPayload({
              checksumToEdit: {
                ...dialogPayload.checksumToEdit,
                checksum: fields,
              },
            });
          }}
          editingIndex={dialogPayload.checksumToEdit.index}
          onCancel={() => {
            closeDialog("editChecksum");
            setDialogPayload({ checksumToEdit: null });
          }}
          onSave={() => {
            const toEdit = dialogPayload.checksumToEdit;
            if (toEdit) {
              handlers.handleSaveChecksum(
                toEdit.checksum,
                toEdit.checksumsParentPath,
                toEdit.index
              );
            }
          }}
        />
      )}

      <ConfirmDeleteDialog
        open={dialogs.deleteNode}
        title="Delete Node"
        message="Are you sure you want to delete node"
        highlightText={dialogPayload.nodeToDelete || undefined}
        onCancel={() => {
          closeDialog("deleteNode");
          setDialogPayload({ nodeToDelete: null });
        }}
        onConfirm={handlers.handleConfirmDeleteNode}
      />

      <ConfirmDeleteDialog
        open={dialogs.deleteGeneric}
        title="Delete"
        message="Are you sure you want to delete"
        highlightText={
          dialogPayload.genericLabel ||
          (dialogPayload.genericPathToDelete?.slice(-1)[0] ?? undefined)
        }
        onCancel={() => {
          closeDialog("deleteGeneric");
          setDialogPayload({ genericPathToDelete: null, genericLabel: null });
        }}
        onConfirm={handlers.handleConfirmDeleteGeneric}
      />

      <ExportCatalogDialog
        open={showExportDialog}
        catalogContent={catalogContent}
        currentFilename={catalogPath?.split("/").pop() || "catalog.toml"}
        onCancel={() => setShowExportDialog(false)}
        onExportComplete={() => setShowExportDialog(false)}
      />

      <ValidationErrorsDialog
        open={dialogs.validationErrors}
        errors={validationErrors}
        isValid={validationIsValid}
        onClose={() => closeDialog("validationErrors")}
      />

      <UnifiedConfigDialog
        open={dialogs.config}
        onCancel={() => closeDialog("config")}
        onSave={handlers.handleSaveConfig}
      />

    </>
  );
}
