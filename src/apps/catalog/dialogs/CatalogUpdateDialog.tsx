// ui/src/apps/catalog/dialogs/CatalogUpdateDialog.tsx
//
// Review an upstream update to a tracked catalogue before it lands.
//
// The diff is computed by the existing Rust `catalog.diff` and rendered by the
// existing DiffView — no bespoke diff or merge UI. Two outcomes:
//
//   * local file unchanged → Apply overwrites it (after a backup)
//   * local file edited    → Open in editor, which loads the remote text as the
//                            working buffer with the on-disk copy as the diff
//                            baseline, so nothing is written until the user saves
//
// The second path is deliberately the *only* way a diverged file changes, and it goes
// through the panel registry rather than a callback prop so it works identically
// wherever the dialog was opened from.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, Download, GitBranch, Loader2, Pencil, Radio, XCircle } from "lucide-react";
import Dialog from "../../../components/Dialog";
import { PrimaryButton, SecondaryButton } from "../../../components/forms";
import DiffView from "../views/DiffView";
import { diffCatalog, type DiffLine } from "../../../api/catalog";
import { iconMd, iconSm } from "../../../styles/spacing";
import {
  alertDanger,
  alertWarning,
  badgeMetadata,
  bgSurface,
  borderDefault,
  borderDivider,
  caption,
  cardCompact,
  h2,
  panelFooter,
  textDanger,
  textMedium,
  textSecondary,
  textWarning,
} from "../../../styles";
import { useCatalogShareStore } from "../../../stores/catalogShareStore";
import { sendUpdateToCatalogEditor } from "../../../utils/windowCommunication";

type Props = {
  isOpen: boolean;
  onClose: () => void;
  /** The tracked catalogue to review. Mounted only while set. */
  catalogId: string;
  /** Absolute decoder directory, to resolve the local path for the handoff. */
  decoderDir: string | null;
};


export default function CatalogUpdateDialog({
  isOpen,
  onClose,
  catalogId,
  decoderDir,
}: Props) {
  const { t } = useTranslation("catalog");

  const updates = useCatalogShareStore((s) => s.updates);
  const loadReview = useCatalogShareStore((s) => s.loadReview);
  const applyUpdate = useCatalogShareStore((s) => s.applyUpdate);
  const clearReview = useCatalogShareStore((s) => s.clearReview);

  const [lines, setLines] = useState<DiffLine[]>([]);
  const [diffError, setDiffError] = useState<string | null>(null);

  const review = updates.reviewing;

  useEffect(() => {
    void loadReview(catalogId);
    return clearReview;
  }, [catalogId, loadReview, clearReview]);

  // Diff in Rust, the same engine the editor's own diff view uses.
  useEffect(() => {
    if (!review) {
      setLines([]);
      return;
    }
    let cancelled = false;
    setDiffError(null);
    void diffCatalog(review.remoteToml, review.localToml)
      .then((diff) => {
        if (!cancelled) setLines(diff.lines);
      })
      .catch((error) => {
        if (!cancelled) setDiffError(String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [review]);

  const diverged = review?.localState === "modified";
  const blocked = (review?.validationErrors.length ?? 0) > 0;

  const handleApply = async () => {
    if (!review) return;
    const ok = await applyUpdate(
      review.catalogId,
      review.remoteToml,
      review.localSha ?? null,
    );
    if (ok) onClose();
  };

  const handleOpenInEditor = () => {
    if (!review || !decoderDir) return;
    sendUpdateToCatalogEditor({
      path: `${decoderDir}/${review.localFilename}`,
      localToml: review.localToml,
      remoteToml: review.remoteToml,
      source: review.repoLabel,
    });
    onClose();
  };

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-4xl">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider}`}>
          <h2 className={h2}>{t("update.title")}</h2>
          {review && (
            <p className={caption}>
              {review.localFilename} · <GitBranch className={`${iconSm} inline`} />{" "}
              {review.repoLabel}
            </p>
          )}
        </div>

        <div className="p-4 space-y-3">
          {updates.loadingReview && (
            <div className="flex items-center gap-2">
              <Loader2 className={`${iconMd} ${textSecondary} animate-spin`} />
              <span className={caption}>{t("update.loading")}</span>
            </div>
          )}

          {updates.reviewError && (
            <div className={`${alertDanger} flex items-start gap-2`}>
              <XCircle className={`${iconMd} ${textDanger} flex-shrink-0 mt-0.5`} />
              <p className={caption}>{updates.reviewError.message}</p>
            </div>
          )}

          {review && (
            <>
              <div className={`${cardCompact} flex items-center gap-2 flex-wrap`}>
                <span className={textMedium}>{t("update.upstreamVersion")}</span>
                <span className={badgeMetadata}>{review.remoteBlobSha.slice(0, 7)}</span>
                {review.transmitFrameCount > 0 && (
                  <span className={`${caption} ${textWarning} inline-flex items-center gap-1`}>
                    <Radio className={iconSm} />
                    {t("update.transmitFrames", { count: review.transmitFrameCount })}
                  </span>
                )}
              </div>

              {blocked && (
                <div className={`${alertDanger} flex items-start gap-2`}>
                  <XCircle className={`${iconMd} ${textDanger} flex-shrink-0 mt-0.5`} />
                  <div>
                    <p className={textMedium}>{t("update.invalid")}</p>
                    <p className={caption}>{review.validationErrors.join("; ")}</p>
                  </div>
                </div>
              )}

              {/* A diverged file is never overwritten — that is the whole point of
                  routing it through the editor instead. */}
              {diverged && (
                <div className={`${alertWarning} flex items-start gap-2`}>
                  <AlertTriangle className={`${iconMd} ${textWarning} flex-shrink-0 mt-0.5`} />
                  <p className={caption}>{t("update.divergedWarning")}</p>
                </div>
              )}

              <div>
                <p className={`${caption} mb-1`}>{t("update.diffLegend")}</p>
                <div className={`max-h-[46vh] overflow-auto rounded-lg border ${borderDefault}`}>
                  {diffError ? (
                    <p className={`p-4 ${caption} ${textDanger}`}>{diffError}</p>
                  ) : (
                    <DiffView lines={lines} />
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className={`${panelFooter} flex justify-end gap-2`}>
          <SecondaryButton onClick={onClose}>{t("update.cancel")}</SecondaryButton>
          {review && decoderDir && (
            <SecondaryButton onClick={handleOpenInEditor}>
              <Pencil className={iconMd} />
              {t("update.openInEditor")}
            </SecondaryButton>
          )}
          {/* Overwriting is offered only when there is nothing local to lose. */}
          {review && !diverged && (
            <PrimaryButton
              onClick={() => void handleApply()}
              disabled={blocked || updates.applying}
            >
              {updates.applying ? (
                <Loader2 className={`${iconMd} animate-spin`} />
              ) : (
                <Download className={iconMd} />
              )}
              {t("update.apply")}
            </PrimaryButton>
          )}
        </div>
      </div>
    </Dialog>
  );
}
