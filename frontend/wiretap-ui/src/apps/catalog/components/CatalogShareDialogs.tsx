// ui/src/apps/catalog/components/CatalogShareDialogs.tsx
//
// The interlinked catalogue-sharing dialogs, plus the state that drives them.
//
// Both the Catalog editor and Settings → Catalogs offer the same four dialogs
// (publish, account, create repository, update review) and they interlink —
// publish hands off to account and to create-repo, and create-repo hands the new
// repository's URL back to publish. Owning that here keeps the two call sites to a
// hook and one element instead of duplicating the wiring.
//
// The repositories dialog is deliberately not part of the set: it hands off to
// nothing, and the catalogue picker mounts it directly so every app can reach it.

import { useState } from "react";
import PublishCatalogDialog from "../dialogs/publish/PublishCatalogDialog";
import GitHubTokenDialog from "../dialogs/GitHubTokenDialog";
import CreateCatalogRepoDialog from "../dialogs/CreateCatalogRepoDialog";
import CatalogUpdateDialog from "../dialogs/CatalogUpdateDialog";

export type CatalogShareDialogControls = {
  /** Publish one catalogue by its filename in the decoder directory. */
  openPublish: (filename: string) => void;
  openAccount: () => void;
  openCreateRepo: () => void;
  /** Review an upstream update by tracked-catalogue id. */
  openUpdate: (catalogId: string) => void;
  /** Render this where the dialogs should mount. */
  element: React.ReactNode;
};

type Options = {
  /** Decoder directory, needed to resolve local paths for the update handoff. */
  decoderDir?: string | null;
};

export function useCatalogShareDialogs({
  decoderDir = null,
}: Options = {}): CatalogShareDialogControls {
  const [accountOpen, setAccountOpen] = useState(false);
  const [createRepoOpen, setCreateRepoOpen] = useState(false);
  // The filename doubles as the open flag: publishing is always about one file.
  const [publishFilename, setPublishFilename] = useState<string | null>(null);
  // Likewise the catalogue id for the update review.
  const [updateCatalogId, setUpdateCatalogId] = useState<string | null>(null);
  // Carries a just-created repository's URL into the publish form, so the user does
  // not have to copy it across by hand. Cleared when publish closes: it is a
  // one-shot handoff, and left set it would re-save and re-select that repository
  // on every later publish, quietly overriding the starred one.
  const [publishRepoUrl, setPublishRepoUrl] = useState("");

  // Mounted only while open. A closed dialog would otherwise still run its hooks and
  // build its whole element tree on every render of the host panel, and these are
  // large: the publish dialog alone holds ten store subscriptions.
  const element = (
    <>
      {publishFilename !== null && (
        <PublishCatalogDialog
          isOpen
          onClose={() => {
            setPublishFilename(null);
            setPublishRepoUrl("");
          }}
          filename={publishFilename}
          initialRepoUrl={publishRepoUrl}
          onNeedAccount={() => setAccountOpen(true)}
          onNeedRepo={() => setCreateRepoOpen(true)}
        />
      )}
      {accountOpen && <GitHubTokenDialog isOpen onClose={() => setAccountOpen(false)} />}
      {createRepoOpen && (
        <CreateCatalogRepoDialog
          isOpen
          onClose={() => setCreateRepoOpen(false)}
          onCreated={setPublishRepoUrl}
        />
      )}
      {updateCatalogId !== null && (
        <CatalogUpdateDialog
          isOpen
          onClose={() => setUpdateCatalogId(null)}
          catalogId={updateCatalogId}
          decoderDir={decoderDir}
        />
      )}
    </>
  );

  return {
    openPublish: (filename) => setPublishFilename(filename),
    openAccount: () => setAccountOpen(true),
    openCreateRepo: () => setCreateRepoOpen(true),
    openUpdate: (catalogId) => setUpdateCatalogId(catalogId),
    element,
  };
}
