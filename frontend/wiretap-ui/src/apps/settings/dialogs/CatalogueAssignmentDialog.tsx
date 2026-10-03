// ui/src/apps/settings/dialogs/CatalogueAssignmentDialog.tsx

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { BookOpen, Download, RefreshCw } from "lucide-react";
import Dialog, { DialogBody, DialogFooter } from "../../../components/Dialog";
import { Alert, type AlertTone } from "../../../components/Alert";
import { Badge, type BadgeTone } from "../../../components/Badge";
import { Button, IconButton } from "../../../components/Button";
import { Listbox, Option } from "../../../components/Listbox";
import { Table } from "../../../components/Table";
import { DangerButton, PrimaryButton, SecondaryButton } from "../../../components/forms";
import { iconMd, iconSm } from "../../../styles/spacing";
import { h3, textMuted } from "../../../styles";
import { useCatalogList } from "../../../hooks/useCatalogList";
import {
  gatewayAssignCatalogue,
  gatewayClearAssignment,
  gatewayCopyCatalogue,
  gatewayListDaemons,
} from "../../../api/backendApi";
import type { AssignmentOutcome } from "../../../generated/AssignmentOutcome";
import type { AssignmentStatus } from "../../../generated/AssignmentStatus";
import type { CatalogueFinding } from "../../../generated/CatalogueFinding";
import type { CatalogueRef } from "../../../generated/CatalogueRef";
import type { GatewayDaemon } from "../../../generated/GatewayDaemon";
import type { GatewayDevice } from "../../../generated/GatewayDevice";
import type { IOProfile } from "../stores/settingsStore";

type Props = {
  isOpen: boolean;
  profile: IOProfile | null;
  onClose: () => void;
};

type Target = { kind: "assign" | "clear"; daemonId: string; device: GatewayDevice };

type Notice = { tone: AlertTone; text: string; findings?: CatalogueFinding[] };

const STATUS_TONE: Record<AssignmentStatus["state"], BadgeTone> = {
  unassigned: "neutral",
  applied: "success",
  pending: "warning",
  refused: "danger",
};

const shortSha = (sha: string) => sha.slice(0, 8);

function CatalogueCell({ catalogue }: { catalogue: CatalogueRef | null | undefined }) {
  if (!catalogue) return <span className={textMuted}>—</span>;
  return (
    <span title={catalogue.blobSha}>
      {catalogue.name && <span className="mr-2">{catalogue.name}</span>}
      <span className={`font-mono ${textMuted}`}>{shortSha(catalogue.blobSha)}</span>
    </span>
  );
}

export default function CatalogueAssignmentDialog({ isOpen, profile, onClose }: Props) {
  const profileId = isOpen ? (profile?.id ?? null) : null;
  const { t } = useTranslation("settings");
  const s = (key: string, opts?: Record<string, unknown>) => t(`dialogs.catalogueAssignment.${key}`, opts);
  const library = useCatalogList();
  const [daemons, setDaemons] = useState<GatewayDaemon[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!profileId) return;
    setLoading(true);
    try {
      setDaemons(await gatewayListDaemons(profileId));
    } catch (e) {
      setNotice({ tone: "danger", text: String(e) });
    } finally {
      setLoading(false);
    }
  }, [profileId]);

  useEffect(() => {
    setDaemons(null);
    setNotice(null);
    setTarget(null);
    void refresh();
  }, [refresh]);

  const report = (outcome: AssignmentOutcome, done: string) => {
    switch (outcome.outcome) {
      case "done":
        return outcome.warnings.length > 0
          ? setNotice({ tone: "warning", text: s("doneWithWarnings"), findings: outcome.warnings })
          : setNotice({ tone: "success", text: done });
      case "rejected":
        return setNotice({ tone: "danger", text: s("rejected"), findings: outcome.findings });
      case "conflict":
        return setNotice({ tone: "warning", text: s("conflict") });
    }
  };

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } catch (e) {
      setNotice({ tone: "danger", text: String(e) });
    } finally {
      setBusy(false);
      setTarget(null);
      await refresh();
    }
  };

  const confirm = () => {
    if (!profileId || !target || (target.kind === "assign" && !chosen)) return;
    const { kind, daemonId, device } = target;
    const expected = device.assigned?.blobSha ?? "";
    return run(async () =>
      kind === "clear"
        ? report(await gatewayClearAssignment(profileId, daemonId, device.interface, expected), s("cleared"))
        : report(await gatewayAssignCatalogue(profileId, daemonId, device.interface, chosen!, expected), s("assigned")),
    );
  };

  const copy = (catalogue: CatalogueRef) => {
    if (!profileId) return;
    return run(async () => {
      const path = await gatewayCopyCatalogue(profileId, catalogue);
      setNotice({ tone: "success", text: s("copied", { path }) });
    });
  };

  const open = (kind: Target["kind"], daemonId: string, device: GatewayDevice) => {
    setChosen(device.assigned?.localFilename ?? null);
    setNotice(null);
    setTarget({ kind, daemonId, device });
  };

  const statusLabel = (status: AssignmentStatus) =>
    status.state === "refused"
      ? s("status.refused", { reason: t(`dialogs.catalogueAssignment.refusal.${status.reason}`, status.reason) })
      : s(`status.${status.state}`);

  const table = (daemon: GatewayDaemon) => (
    <Table>
      <thead>
        <tr>
          <th>{s("columns.interface")}</th>
          <th>{s("columns.assigned")}</th>
          <th>{s("columns.running")}</th>
          <th>{s("columns.status")}</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {daemon.devices.map((device) => (
          <tr key={device.interface}>
            <td className="font-mono">{device.interface}</td>
            <td>
              <CatalogueCell catalogue={device.assigned} />
              {device.assigned && !device.assigned.localFilename && (
                <IconButton
                  size="xs"
                  title={s("copy")}
                  disabled={busy}
                  onClick={() => copy(device.assigned!)}
                >
                  <Download className={iconSm} />
                </IconButton>
              )}
            </td>
            <td>
              {device.active ? (
                <>
                  <Badge size="sm" className="mr-2">
                    {t(`dialogs.catalogueAssignment.source.${device.active.source}`, device.active.source)}
                  </Badge>
                  <CatalogueCell catalogue={device.active.catalogue} />
                </>
              ) : (
                <span className={textMuted}>{s("notReported")}</span>
              )}
            </td>
            <td>
              <Badge tone={STATUS_TONE[device.status.state]} size="sm">
                {statusLabel(device.status)}
              </Badge>
            </td>
            <td className="text-right whitespace-nowrap">
              <Button size="xs" disabled={busy} onClick={() => open("assign", daemon.daemonId, device)}>
                {s("assign")}
              </Button>
              {device.assigned && (
                <Button
                  size="xs"
                  tone="danger"
                  variant="ghost"
                  className="ml-1"
                  disabled={busy}
                  onClick={() => open("clear", daemon.daemonId, device)}
                >
                  {s("clear")}
                </Button>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </Table>
  );

  const picker = (current: Target) =>
    current.kind === "clear" ? (
      <p>{s("confirmClear", { interface: current.device.interface, daemon: current.daemonId })}</p>
    ) : (
      <div className="space-y-2">
        <p>{s("pick", { interface: current.device.interface, daemon: current.daemonId })}</p>
        {library.length === 0 ? (
          <Alert tone="info">{s("emptyLibrary")}</Alert>
        ) : (
          <Listbox className="max-h-[50vh] overflow-y-auto">
            {library.map((c) => (
              <Option key={c.filename} mark="radio" selected={chosen === c.filename} onClick={() => setChosen(c.filename)}>
                <span className="flex-1 text-left">{c.name}</span>
                <span className={`font-mono text-xs ${textMuted}`}>{c.filename}</span>
              </Option>
            ))}
          </Listbox>
        )}
      </div>
    );

  return (
    <Dialog
      isOpen={profileId !== null}
      onClose={onClose}
      size="3xl"
      icon={<BookOpen className={iconMd} />}
      title={s("title")}
      subtitle={profile?.name}
    >
      <DialogBody className="space-y-4">
        {notice && (
          <Alert tone={notice.tone}>
            <p>{notice.text}</p>
            {notice.findings && notice.findings.length > 0 && (
              <ul className="mt-1 list-disc pl-5">
                {notice.findings.map((f, i) => (
                  <li key={i}>
                    <span className="font-mono">{f.field}</span>: {f.message}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}

        {target ? (
          picker(target)
        ) : daemons === null ? (
          <p className={textMuted}>{loading ? t("common:states.loading") : null}</p>
        ) : daemons.length === 0 ? (
          <p className={textMuted}>{s("noDaemons")}</p>
        ) : (
          daemons.map((daemon) => (
            <section key={daemon.daemonId} className="space-y-2">
              <h3 className={h3}>{daemon.daemonId}</h3>
              {table(daemon)}
            </section>
          ))
        )}
      </DialogBody>
      <DialogFooter>
        {target ? (
          <>
            <SecondaryButton disabled={busy} onClick={() => setTarget(null)}>
              {t("common:actions.cancel")}
            </SecondaryButton>
            {target.kind === "clear" ? (
              <DangerButton disabled={busy} onClick={confirm}>
                {s("clear")}
              </DangerButton>
            ) : (
              <PrimaryButton disabled={busy || !chosen} onClick={confirm}>
                {s("assign")}
              </PrimaryButton>
            )}
          </>
        ) : (
          <>
            <SecondaryButton disabled={loading || busy} onClick={refresh}>
              <RefreshCw className={iconMd} />
              {s("refresh")}
            </SecondaryButton>
            <PrimaryButton onClick={onClose}>{t("common:actions.close")}</PrimaryButton>
          </>
        )}
      </DialogFooter>
    </Dialog>
  );
}
