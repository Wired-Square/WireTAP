// ui/src/apps/catalog/dialogs/publish/usePublishDiff.ts
//
// The Changes tab's data: what this push would change upstream.
//
// Lazy on purpose. Preflight is on the critical path of every target change, so a tab
// the user may never open must not be part of it. Debounced on purpose too: the path
// and branch are text inputs, and "no network" is not the same as "no cost" — each
// keystroke would otherwise open the repository and walk a tree.
//
// The diff itself arrives rendered. Rust holds both texts already, so it runs the same
// LCS the editor's diff view uses and sends rows; asking for the texts and calling
// `catalog.diff` would ship both files out and straight back in.

import { useCallback, useEffect, useRef, useState } from "react";
import { asShareError, publishDiff, type PublishDiff } from "../../../../api/catalogShare";

/** Long enough to swallow typing, short enough that a tab switch feels immediate. */
const DEBOUNCE_MS = 300;

type PublishDiffState = {
  diff: PublishDiff | null;
  loading: boolean;
  error: string | null;
};

export type PublishDiffResult = PublishDiffState & { reload: () => void };

type Args = {
  /**
   * Set once the Changes tab has been opened, and never unset. Gating on
   * `tab === "diff"` instead would re-fetch on every visit while still missing the
   * case that matters: a branch or path edited *while* the tab is open.
   */
  enabled: boolean;
  filename: string | null;
  repoUrl: string | null;
  targetPath: string;
  branch: string;
  baseBranch: string;
};

const EMPTY: PublishDiffState = { diff: null, loading: false, error: null };

export function usePublishDiff({
  enabled,
  filename,
  repoUrl,
  targetPath,
  branch,
  baseBranch,
}: Args): PublishDiffResult {
  const [state, setState] = useState<PublishDiffState>(EMPTY);
  // Bumped to re-run the effect for a retry without changing what it asks for.
  const [attempt, setAttempt] = useState(0);
  // Monotonic, so a slow reply from a superseded request is dropped rather than
  // overwriting a newer one. A ref for the same reason `requestId` is one: it is never
  // rendered, and as state it would restart the effect it exists to guard.
  const seq = useRef(0);

  const ready = enabled && !!filename && !!repoUrl && !!targetPath && !!baseBranch;

  useEffect(() => {
    if (!ready) {
      setState(EMPTY);
      return;
    }
    const mine = ++seq.current;
    // Same values means the same object, so React's bail-out turns a render per
    // keystroke into none.
    setState((prev) =>
      prev.loading && prev.error === null ? prev : { ...prev, loading: true, error: null },
    );

    const timer = setTimeout(() => {
      void publishDiff({
        filename: filename!,
        repoUrl: repoUrl!,
        targetPath,
        branch,
        baseBranch,
      })
        .then((diff) => {
          if (seq.current === mine) setState({ diff, loading: false, error: null });
        })
        .catch((error) => {
          // A failed preview never blocks the push — it is a preview.
          if (seq.current === mine) {
            setState({ ...EMPTY, error: asShareError(error).message });
          }
        });
    }, DEBOUNCE_MS);

    return () => clearTimeout(timer);
  }, [ready, filename, repoUrl, targetPath, branch, baseBranch, attempt]);

  const reload = useCallback(() => setAttempt((n) => n + 1), []);
  return { ...state, reload };
}
