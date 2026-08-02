// ui/src/apps/catalog/dialogs/publish/RepoPicker.tsx
//
// Which repository the push goes to.
//
// Owns the add-by-URL row, which is a small state machine nothing else in the dialog
// touches: `addingUrl` is both "is the row showing" and "what is in it", so `null`
// means hidden and `""` means showing and empty.

import { useState } from "react";
import {
  FormField,
  Input,
  PrimaryButton,
  SecondaryButton,
  Select,
} from "../../../../components/forms";
import { caption, textDanger } from "../../../../styles";
import { savedRepoName } from "../../../../api/catalogShare";
import { useCatalogShareStore } from "../../../../stores/catalogShareStore";
import type { T } from "./types";

/**
 * Sentinel for the dropdown's "add by URL" row. Not a valid repo id — ids are
 * `gh:owner/repo` — so it cannot collide with a real entry.
 */
const ADD_REPO_OPTION = "__add__";

type Props = {
  t: T;
  /** The selected id, which is the starred repository until the user picks one. */
  value: string | null;
  onPick: (id: string | null) => void;
  onCreateRepo: () => void;
};

export default function RepoPicker({ t, value, onPick, onCreateRepo }: Props) {
  const savedRepos = useCatalogShareStore((s) => s.savedRepos);
  const favouriteRepoId = useCatalogShareStore((s) => s.favouriteRepoId);
  const saveRepo = useCatalogShareStore((s) => s.saveRepo);
  const reposError = useCatalogShareStore((s) => s.reposError);

  const [addingUrl, setAddingUrl] = useState<string | null>(null);

  const handleAdd = async (url: string) => {
    const saved = await saveRepo(url.trim());
    if (saved) {
      onPick(saved.id);
      setAddingUrl(null);
    }
  };

  return (
    <>
      <div className="flex gap-2 items-end">
        <div className="flex-1 min-w-0">
          <FormField label={t("publish.repoLabel")}>
            <Select
              value={addingUrl === null ? (value ?? "") : ADD_REPO_OPTION}
              onChange={(e) => {
                if (e.target.value === ADD_REPO_OPTION) {
                  setAddingUrl("");
                } else {
                  setAddingUrl(null);
                  onPick(e.target.value || null);
                }
              }}
            >
              <option value="">{t("publish.repoPlaceholder")}</option>
              {savedRepos.map((repo) => (
                <option key={repo.id} value={repo.id}>
                  {savedRepoName(repo)}
                  {repo.id === favouriteRepoId ? " ★" : ""}
                </option>
              ))}
              <option value={ADD_REPO_OPTION}>{t("publish.repoAddOption")}</option>
            </Select>
          </FormField>
        </div>
        <SecondaryButton onClick={onCreateRepo}>{t("publish.createRepo")}</SecondaryButton>
      </div>

      {addingUrl !== null && (
        <div className="flex gap-2 items-end">
          <div className="flex-1 min-w-0">
            <FormField label={t("publish.repoUrlLabel")}>
              <Input
                value={addingUrl}
                onChange={(e) => setAddingUrl(e.target.value)}
                placeholder="https://github.com/owner/repo"
                autoFocus
              />
            </FormField>
          </div>
          <SecondaryButton onClick={() => setAddingUrl(null)}>
            {t("publish.cancel")}
          </SecondaryButton>
          <PrimaryButton onClick={() => void handleAdd(addingUrl)} disabled={!addingUrl.trim()}>
            {t("publish.repoAdd")}
          </PrimaryButton>
        </div>
      )}

      {reposError && <p className={`${caption} ${textDanger}`}>{reposError.message}</p>}

      {savedRepos.length === 0 && addingUrl === null && (
        <p className={caption}>{t("publish.repoNone")}</p>
      )}
    </>
  );
}
