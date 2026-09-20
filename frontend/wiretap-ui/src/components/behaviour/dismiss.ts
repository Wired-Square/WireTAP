// Escape reaches only the layer opened last: dialogs, menus and popovers share
// one stack, so a menu over a dialog closes alone and the dialog on the next
// press. A layer whose handler does nothing still holds the top, which is how
// a dialog that must be answered swallows Escape.

const layers: symbol[] = [];

export interface DismissLayer {
  onDismiss: () => void;
  /** Whether a mousedown target is inside the layer; absent, clicks are not watched */
  isInside?: (target: Node) => boolean;
}

/** Push a layer onto the stack; the returned function removes it and its listeners. */
export function pushDismissLayer({ onDismiss, isInside }: DismissLayer): () => void {
  const self = Symbol("layer");
  layers.push(self);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Escape" || e.defaultPrevented || e.isComposing) return;
    if (layers[layers.length - 1] !== self) return;
    e.preventDefault();
    onDismiss();
  };
  const onMouseDown =
    isInside &&
    ((e: MouseEvent) => {
      if (!isInside(e.target as Node)) onDismiss();
    });
  document.addEventListener("keydown", onKeyDown);
  if (onMouseDown) document.addEventListener("mousedown", onMouseDown);
  return () => {
    document.removeEventListener("keydown", onKeyDown);
    if (onMouseDown) document.removeEventListener("mousedown", onMouseDown);
    layers.splice(layers.indexOf(self), 1);
  };
}
