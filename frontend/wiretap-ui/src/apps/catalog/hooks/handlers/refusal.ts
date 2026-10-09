import { useCatalogEditorStore } from "../../../../stores/catalogEditorStore";

/** Show why the crate refused an edit, in the validation dialog. The refused draft never reached the catalogue, so its verdict stands. */
export function showRefusal(field: string, error: unknown) {
  const { setValidation, openDialog, validation } = useCatalogEditorStore.getState();
  setValidation([{ field, message: error instanceof Error ? error.message : String(error) }], validation.isValid);
  openDialog("validationErrors");
}
