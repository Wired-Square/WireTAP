// ui/src/dialogs/DecoderInfoDialog.tsx

import { useEffect, useState } from "react";
import { FileText, Shuffle, Zap, GitBranch, Clock, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { iconMd, iconXs, flexRowGap2 } from "../styles/spacing";
import { captionMuted, emptyStateText } from "../styles/typography";
import Dialog, { DialogBody } from "../components/Dialog";
import { useDiscoveryStore } from "../stores/discoveryStore";
import { draftPreview } from "../api/drafting";
import type { DraftPreview } from "../generated/DraftPreview";
import type { DraftSignal } from "../generated/DraftSignal";
import type { FrameDraft } from "../generated/FrameDraft";
import type { MuxDraft } from "../generated/MuxDraft";
import { frameNoteLines, formatMuxValue } from "../utils/analysis/byteNoteText";
import { formatFrameKey } from "../utils/frameIds";
import { parseFrameKey } from "../utils/frameKey";
import { formatMs } from "../utils/reportExport";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function DecoderInfoDialog({ isOpen, onClose }: Props) {
  const { t } = useTranslation("dialogs");
  const draft = useDiscoveryStore((s) => s.draft);
  const frameInfoMap = useDiscoveryStore((s) => s.frameInfoMap);
  const [preview, setPreview] = useState<DraftPreview | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const frames = Array.from(frameInfoMap, ([fk, info]) => ({
      protocol: info.protocol ?? "can",
      frameId: parseFrameKey(fk).frameId,
      isExtended: !!info.isExtended,
      length: info.len,
    }));
    let current = true;
    draftPreview(draft, frames).then((p) => current && setPreview(p), () => current && setPreview(null));
    return () => {
      current = false;
    };
  }, [isOpen, draft, frameInfoMap]);

  const frames = preview?.draft.frames ?? [];
  const analysed = draft !== null;
  const muxCount = frames.filter((f) => f.mux).length;
  const burstCount = frames.filter((f) => f.burst).length;
  const multiBusCount = frames.filter((f) => Object.keys(f.buses).length > 1).length;

  return (
    <Dialog
      isOpen={isOpen}
      onClose={onClose}
      size="xl"
      title={t("decoderInfo.title")}
      subtitle={t("decoderInfo.subtitle")}
      icon={<FileText className="text-info" />}
    >
      <DialogBody className="space-y-6">
        {/* Meta Section */}
        <MetaSection preview={preview} t={t} />

        {/* Stats Summary */}
        <div className="flex flex-wrap gap-4 text-xs p-3 bg-surface rounded-lg">
          <span className="text-muted">
            <span className="font-medium text-primary">{frames.length}</span> {t("decoderInfo.stats.frames")}
          </span>
          {muxCount > 0 && (
            <span className="text-orange">
              <span className="font-medium">{muxCount}</span> {t("decoderInfo.stats.mux")}
            </span>
          )}
          {burstCount > 0 && (
            <span className="text-cyan">
              <span className="font-medium">{burstCount}</span> {t("decoderInfo.stats.burst")}
            </span>
          )}
          {multiBusCount > 0 && (
            <span className="text-danger">
              <span className="font-medium">{multiBusCount}</span> {t("decoderInfo.stats.multiBus")}
            </span>
          )}
          {analysed && (
            <span className="text-green ml-auto">
              {t("decoderInfo.stats.analysisRun")}
            </span>
          )}
          {!analysed && (
            <span className="text-amber ml-auto">
              {t("decoderInfo.stats.runAnalysis")}
            </span>
          )}
        </div>

        {/* Frames Section */}
        <FramesSection preview={preview} t={t} />
      </DialogBody>
    </Dialog>
  );
}

// ============================================================================
// Meta Section
// ============================================================================

type SectionProps = {
  preview: DraftPreview | null;
  t: TFunction;
};

function MetaSection({ preview, t }: SectionProps) {
  const defaultInterval = preview?.draft.defaultIntervalMs ?? null;

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Layers className={`${iconMd} text-purple`} />
        <h3 className="text-xs font-medium text-secondary">
          {t("decoderInfo.meta.title")}
        </h3>
      </div>
      <Card className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">default_frame</span>
          <span className="font-mono text-primary">"{preview?.defaultFrame ?? "can"}"</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">default_endianness</span>
          <span className="font-mono text-primary">"{preview?.draft.defaultEndianness ?? "little"}"</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">default_interval</span>
          {defaultInterval !== null ? (
            <span className="font-mono text-green">{Math.round(defaultInterval)}</span>
          ) : (
            <span className="text-muted italic">{t("decoderInfo.meta.notDetermined")}</span>
          )}
        </div>
      </Card>
    </section>
  );
}

// ============================================================================
// Frames Section
// ============================================================================

function FramesSection({ preview, t }: SectionProps) {
  const frames = preview?.draft.frames ?? [];

  if (frames.length === 0) {
    return (
      <section>
        <div className="flex items-center gap-2 mb-3">
          <Clock className={`${iconMd} text-muted`} />
          <h3 className="text-xs font-medium text-secondary">
            {t("decoderInfo.frames.title")}
          </h3>
        </div>
        <p className={emptyStateText}>{t("decoderInfo.frames.empty")}</p>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center gap-2 mb-3">
        <Clock className={`${iconMd} text-green`} />
        <h3 className="text-xs font-medium text-secondary">
          {t("decoderInfo.frames.titleWithCount", { count: frames.length })}
        </h3>
      </div>
      <div className="space-y-2">
        {frames.map((frame, i) => (
          <FrameCard
            key={`${frame.protocol}:${frame.frameId}:${frame.isExtended}`}
            frame={frame}
            signals={preview?.signals[i] ?? []}
            t={t}
          />
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// Frame Card
// ============================================================================

type FrameCardProps = {
  frame: FrameDraft;
  signals: DraftSignal[];
  t: TFunction;
};

function FrameCard({ frame, signals, t }: FrameCardProps) {
  const buses = Object.entries(frame.buses);
  const notes = frameNoteLines(t, frame.notes, frame.mux?.selector);

  return (
    <Card>
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className={flexRowGap2}>
          <span className="font-mono font-semibold text-sm text-primary">
            {formatFrameKey(frame.protocol, frame)}
          </span>
          <span className={captionMuted}>
            {t("decoderInfo.frames.bytesLabel", { count: frame.length })}
          </span>
          {frame.isExtended && (
            <Badge tone="warning" size="sm">{t("decoderInfo.frames.extBadge")}</Badge>
          )}
        </div>
        <div className={flexRowGap2}>
          {frame.intervalMs !== null && (
            <span className="text-xs text-green">
              {formatMs(frame.intervalMs)}
            </span>
          )}
          {frame.bus !== null && (
            <span className={captionMuted}>
              {t("decoderInfo.frames.busLabel", { bus: frame.bus })}
            </span>
          )}
        </div>
      </div>

      {/* Flags */}
      <div className="flex flex-wrap gap-1 mb-2">
        {frame.mux && (
          <Badge tone="warning" size="sm">
            <Shuffle className={iconXs} />
            {frame.mux.selector === "twoByte" ? t("decoderInfo.frames.muxBadgeTwoByte") : t("decoderInfo.frames.muxBadge")}
          </Badge>
        )}
        {frame.burst && (
          <Badge tone="cyan" size="sm">
            <Zap className={iconXs} />
            {t("decoderInfo.frames.burstBadge")}
          </Badge>
        )}
        {buses.length > 1 && (
          <Badge tone="danger" size="sm">
            <GitBranch className={iconXs} />
            {t("decoderInfo.frames.multiBusBadge")}
          </Badge>
        )}
      </div>

      {/* Mux Details */}
      {frame.mux && <MuxDetails mux={frame.mux} t={t} />}

      {/* Burst Details */}
      {frame.burst && (
        <div className="text-2xs text-muted mb-2">
          {t("decoderInfo.frames.burstDetails", {
            count: frame.burst.framesPerBurst,
            period: formatMs(frame.burst.burstPeriodMs),
          })}
          {frame.burst.flags.length > 0 && (
            <span className="ml-1 text-cyan">
              ({frame.burst.flags.join(", ")})
            </span>
          )}
        </div>
      )}

      {/* Multi-bus Details */}
      {buses.length > 1 && (
        <div className="text-2xs text-muted mb-2">
          {t("decoderInfo.frames.seenOnBuses")} {buses.map(([bus, count]) => (
            <span key={bus} className="ml-1">
              {bus} ({count}×)
            </span>
          ))}
        </div>
      )}

      {/* Signals */}
      {signals.length > 0 && (
        <div className="mt-2 pt-2 border-t border-default">
          <div className="text-2xs font-medium text-muted mb-1">
            {t("decoderInfo.frames.signalsTitle")}
          </div>
          <div className="space-y-1">
            {signals.map((signal, idx) => (
              <div
                key={idx}
                className={`flex items-center justify-between text-2xs ${
                  signal.source === 'fill'
                    ? 'text-muted italic'
                    : 'text-secondary'
                }`}
              >
                <span className="font-mono">{signal.name}</span>
                <span>
                  bit[{signal.startBit}:{signal.startBit + signal.bitLength - 1}]
                  {signal.source === 'fill' && t("decoderInfo.frames.defaultSuffix")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {notes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-default">
          <div className="text-2xs font-medium text-muted mb-1">
            {t("decoderInfo.frames.notesTitle")}
          </div>
          <ul className="space-y-0.5">
            {notes.map((note, idx) => (
              <li key={idx} className="text-2xs text-secondary">
                • {note}
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}

// ============================================================================
// Mux Details
// ============================================================================

type MuxDetailsProps = {
  mux: MuxDraft;
  t: TFunction;
};

function MuxDetails({ mux, t }: MuxDetailsProps) {
  const twoByte = mux.selector === "twoByte";
  const cases = Object.keys(mux.cases).map(Number);
  return (
    <div className="text-2xs text-muted mb-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium text-orange">
          {twoByte ? t("decoderInfo.mux.selectorTwoByte") : t("decoderInfo.mux.selectorOneByte")}
        </span>
        <span className="font-mono">
          {twoByte ? "byte[0:1]" : "byte[0]"}
        </span>
        <span>
          (bit[0:{twoByte ? 15 : 7}])
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        <span className="text-muted">{t("decoderInfo.mux.casesLabel")}</span>
        {cases.slice(0, 16).map((c) => (
          <Badge key={c} tone="warning" size="sm" mono>
            {formatMuxValue(c, mux.selector)}
          </Badge>
        ))}
        {cases.length > 16 && (
          <span className="text-muted">
            {t("decoderInfo.mux.more", { count: cases.length - 16 })}
          </span>
        )}
      </div>
    </div>
  );
}
