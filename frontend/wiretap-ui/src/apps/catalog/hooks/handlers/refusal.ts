import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";

/** Show why the crate refused an edit, in the validation dialog. */
export function showRefusal(field: string, error: unknown) {
  const { setValidation, openDialog } = useCatalogEditorStore.getState();
  setValidation([{ field, message: error instanceof Error ? error.message : String(error) }]);
  openDialog("validationErrors");
}
