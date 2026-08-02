// ui/src/apps/catalog/dialogs/GitHubTokenDialog.tsx
//
// Connect a GitHub account for publishing.
//
// The token is validated against GET /user before being stored, so a typo never
// becomes a persisted credential that fails later mid-publish. It lives in the
// system keychain and never crosses back over the IPC boundary — only the login
// and granted scopes do.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import * as ShareIcon from "../../../components/catalogIcons";
import Alert from "../../../components/Alert";
import Dialog from "../../../components/Dialog";
import { PrimaryButton, SecondaryButton } from "../../../components/forms";
import SecurePasswordField from "../../settings/components/SecurePasswordField";
import { iconMd, iconSm } from "../../../styles/spacing";
import { bgSurface, borderDivider, caption, h2, textMedium } from "../../../styles";
import { panelFooter } from "../../../styles/cardStyles";
import { badgeMetadata } from "../../../styles/badgeStyles";
import { gitTokenSetupUrl } from "../../../api/catalogShare";
import { useCatalogShareStore } from "../../../stores/catalogShareStore";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function GitHubTokenDialog({ isOpen, onClose }: Props) {
  const { t } = useTranslation("catalog");
  const [token, setToken] = useState("");

  const account = useCatalogShareStore((s) => s.account);
  const loadIdentity = useCatalogShareStore((s) => s.loadIdentity);
  const connectAccount = useCatalogShareStore((s) => s.connectAccount);
  const verifyAccount = useCatalogShareStore((s) => s.verifyAccount);
  const disconnectAccount = useCatalogShareStore((s) => s.disconnectAccount);

  useEffect(() => {
    if (isOpen) {
      setToken("");
      void loadIdentity();
    }
  }, [isOpen, loadIdentity]);

  const handleConnect = async () => {
    if (await connectAccount(token)) setToken("");
  };

  const identity = account.identity;

  return (
    <Dialog isOpen={isOpen} onBackdropClick={onClose} maxWidth="max-w-lg">
      <div className={`${bgSurface} rounded-xl shadow-xl overflow-hidden`}>
        <div className={`p-4 ${borderDivider}`}>
          <h2 className={h2}>{t("account.title")}</h2>
          <p className={caption}>{t("account.subtitle")}</p>
        </div>

        <div className="p-4 space-y-4">
          {identity && (
            <div className="flex items-center gap-2 flex-wrap">
              <ShareIcon.Success className={`${iconMd} text-[color:var(--accent-success)]`} />
              <span className={textMedium}>{identity.login}</span>
              {identity.scopes.length > 0 ? (
                identity.scopes.map((scope) => (
                  <span key={scope} className={badgeMetadata}>
                    {scope}
                  </span>
                ))
              ) : (
                // Fine-grained tokens report no scopes at all, which is not an error.
                <span className={badgeMetadata}>{t("account.fineGrained")}</span>
              )}
            </div>
          )}

          <SecurePasswordField
            value={token}
            onChange={setToken}
            isSecurelyStored={identity !== null}
            hasLegacyPassword={false}
            placeholder="ghp_…"
            label={t("account.tokenLabel")}
          />

          <div className={caption}>
            <p>{t("account.scopeAdvice")}</p>
            <button
              onClick={() => void gitTokenSetupUrl().then(openUrl)}
              className="mt-1 inline-flex items-center gap-1 underline hover:no-underline"
            >
              <ShareIcon.GitHub className={iconSm} />
              {t("account.createToken")}
            </button>
          </div>

          {account.error && (
            <Alert tone="danger">
              <p className={caption}>{account.error.message}</p>
            </Alert>
          )}
        </div>

        <div className={`${panelFooter} flex justify-between gap-2`}>
          <div className="flex gap-2">
            {identity && (
              <>
                <SecondaryButton onClick={() => void verifyAccount()} disabled={account.busy}>
                  {t("account.verify")}
                </SecondaryButton>
                <SecondaryButton
                  onClick={() => void disconnectAccount()}
                  disabled={account.busy}
                >
                  {t("account.disconnect")}
                </SecondaryButton>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <SecondaryButton onClick={onClose}>{t("account.close")}</SecondaryButton>
            <PrimaryButton
              onClick={() => void handleConnect()}
              disabled={!token.trim() || account.busy}
            >
              {account.busy && <ShareIcon.Busy className={`${iconMd} animate-spin`} />}
              {t("account.connect")}
            </PrimaryButton>
          </div>
        </div>
      </div>
    </Dialog>
  );
}
