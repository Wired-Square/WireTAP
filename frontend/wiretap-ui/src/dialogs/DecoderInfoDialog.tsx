// ui/src/dialogs/DecoderInfoDialog.tsx

import { FileText, Shuffle, Zap, GitBranch, Clock, Layers } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { iconMd, iconXs, flexRowGap2 } from "../styles/spacing";
import { captionMuted, emptyStateText } from "../styles/typography";
import Dialog, { DialogBody } from "../components/Dialog";
import { useDiscoveryStore } from "../stores/discoveryStore";
import type { DecoderKnowledge, FrameKnowledge, MuxKnowledge } from "../utils/decoderKnowledge";
import { createDefaultSignalsForFrame } from "../utils/decoderKnowledge";
import { formatFrameId } from "../utils/frameIds";
import { formatMs } from "../utils/reportExport";
import { Badge } from "../components/Badge";
import { Card } from "../components/Card";

type Props = {
  isOpen: boolean;
  onClose: () => void;
};

export default function DecoderInfoDialog({ isOpen, onClose }: Props) {
  const { t } = useTranslation("dialogs");
  const knowledge = useDiscoveryStore((s) => s.knowledge);

  const frameCount = knowledge.frames.size;
  const muxCount = knowledge.multiplexedFrames.length;
  const burstCount = knowledge.burstFrames.length;
  const multiBusCount = knowledge.multiBusFrames.length;

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
        <MetaSection knowledge={knowledge} t={t} />

        {/* Stats Summary */}
        <div className="flex flex-wrap gap-4 text-xs p-3 bg-surface rounded-lg">
          <span className="text-muted">
            <span className="font-medium text-primary">{frameCount}</span> {t("decoderInfo.stats.frames")}
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
          {knowledge.analysisRun && (
            <span className="text-green ml-auto">
              {t("decoderInfo.stats.analysisRun")}
            </span>
          )}
          {!knowledge.analysisRun && (
            <span className="text-amber ml-auto">
              {t("decoderInfo.stats.runAnalysis")}
            </span>
          )}
        </div>

        {/* Frames Section */}
        <FramesSection knowledge={knowledge} t={t} />
      </DialogBody>
    </Dialog>
  );
}

// ============================================================================
// Meta Section
// ============================================================================

type MetaSectionProps = {
  knowledge: DecoderKnowledge;
  t: TFunction;
};

function MetaSection({ knowledge, t }: MetaSectionProps) {
  const { meta } = knowledge;

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
          <span className="font-mono text-primary">"{meta.defaultFrame}"</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">default_endianness</span>
          <span className="font-mono text-primary">"{meta.defaultEndianness}"</span>
        </div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted">default_interval</span>
          {meta.defaultInterval !== null ? (
            <span className="font-mono text-green">{meta.defaultInterval}</span>
          ) : (
            <span className="text-muted italic">{t("decoderInfo.meta.notDetermined")}</span>
          )}
        </div>
        {meta.defaultInterval !== null && (
          <div className="text-2xs text-muted pt-1">
            {t("decoderInfo.meta.basedOnGroup", {
              count: knowledge.intervalGroups.find(g => g.intervalMs === meta.defaultInterval)?.frameIds.length ?? 0,
            })}
          </div>
        )}
      </Card>
    </section>
  );
}

// ============================================================================
// Frames Section
// ============================================================================

type FramesSectionProps = {
  knowledge: DecoderKnowledge;
  t: TFunction;
};

function FramesSection({ knowledge, t }: FramesSectionProps) {
  const frames = Array.from(knowledge.frames.values()).sort((a, b) => a.frameId - b.frameId);

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
        {frames.map((frame) => (
          <FrameCard key={frame.frameId} frame={frame} t={t} />
        ))}
      </div>
    </section>
  );
}

// ============================================================================
// Frame Card
// ============================================================================

type FrameCardProps = {
  frame: FrameKnowledge;
  t: TFunction;
};

function FrameCard({ frame, t }: FrameCardProps) {
  const defaultSignals = createDefaultSignalsForFrame(frame.length, frame.mux, frame.signals);
  const allSignals = [...frame.signals, ...defaultSignals];

  return (
    <Card>
      {/* Header */}
      <div className="flex items-start justify-between mb-2">
        <div className={flexRowGap2}>
          <span className="font-mono font-semibold text-sm text-primary">
            {formatFrameId(frame.frameId)}
          </span>
          <span className={captionMuted}>
            {t("decoderInfo.frames.bytesLabel", { count: frame.length })}
          </span>
          {frame.isExtended && (
            <Badge tone="warning" size="sm">{t("decoderInfo.frames.extBadge")}</Badge>
          )}
        </div>
        <div className={flexRowGap2}>
          {frame.intervalMs !== undefined && (
            <span className="text-xs text-green">
              {formatMs(frame.intervalMs)}
            </span>
          )}
          {frame.bus !== undefined && (
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
            {frame.mux.isTwoByte ? t("decoderInfo.frames.muxBadgeTwoByte") : t("decoderInfo.frames.muxBadge")}
          </Badge>
        )}
        {frame.isBurst && (
          <Badge tone="cyan" size="sm">
            <Zap className={iconXs} />
            {t("decoderInfo.frames.burstBadge")}
          </Badge>
        )}
        {frame.isMultiBus && (
          <Badge tone="danger" size="sm">
            <GitBranch className={iconXs} />
            {t("decoderInfo.frames.multiBusBadge")}
          </Badge>
        )}
      </div>

      {/* Mux Details */}
      {frame.mux && <MuxDetails mux={frame.mux} t={t} />}

      {/* Burst Details */}
      {frame.burstInfo && (
        <div className="text-2xs text-muted mb-2">
          {t("decoderInfo.frames.burstDetails", {
            count: frame.burstInfo.burstCount,
            period: formatMs(frame.burstInfo.burstPeriodMs),
          })}
          {frame.burstInfo.flags.length > 0 && (
            <span className="ml-1 text-cyan">
              ({frame.burstInfo.flags.join(", ")})
            </span>
          )}
        </div>
      )}

      {/* Multi-bus Details */}
      {frame.multiBusInfo && (
        <div className="text-2xs text-muted mb-2">
          {t("decoderInfo.frames.seenOnBuses")} {frame.multiBusInfo.buses.map(b => (
            <span key={b} className="ml-1">
              {b} ({frame.multiBusInfo!.countPerBus[b]}×)
            </span>
          ))}
        </div>
      )}

      {/* Signals */}
      {allSignals.length > 0 && (
        <div className="mt-2 pt-2 border-t border-default">
          <div className="text-2xs font-medium text-muted mb-1">
            {t("decoderInfo.frames.signalsTitle")}
          </div>
          <div className="space-y-1">
            {allSignals.map((signal, idx) => (
              <div
                key={idx}
                className={`flex items-center justify-between text-2xs ${
                  signal.source === 'default'
                    ? 'text-muted italic'
                    : 'text-secondary'
                }`}
              >
                <span className="font-mono">{signal.name}</span>
                <span>
                  bit[{signal.startBit}:{signal.startBit + signal.bitLength - 1}]
                  {signal.source === 'default' && t("decoderInfo.frames.defaultSuffix")}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Notes */}
      {frame.notes.length > 0 && (
        <div className="mt-2 pt-2 border-t border-default">
          <div className="text-2xs font-medium text-muted mb-1">
            {t("decoderInfo.frames.notesTitle")}
          </div>
          <ul className="space-y-0.5">
            {frame.notes.map((note, idx) => (
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
  mux: MuxKnowledge;
  t: TFunction;
};

function MuxDetails({ mux, t }: MuxDetailsProps) {
  return (
    <div className="text-2xs text-muted mb-2">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-medium text-orange">
          {mux.isTwoByte ? t("decoderInfo.mux.selectorTwoByte") : t("decoderInfo.mux.selectorOneByte")}
        </span>
        <span className="font-mono">
          {mux.isTwoByte ? "byte[0:1]" : `byte[${mux.selectorByte}]`}
        </span>
        <span>
          (bit[{mux.selectorStartBit}:{mux.selectorStartBit + mux.selectorBitLength - 1}])
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        <span className="text-muted">{t("decoderInfo.mux.casesLabel")}</span>
        {mux.cases.slice(0, 16).map((c) => (
          <Badge key={c} tone="warning" size="sm" mono>
            {mux.isTwoByte ? `${Math.floor(c / 256)}.${c % 256}` : c}
          </Badge>
        ))}
        {mux.cases.length > 16 && (
          <span className="text-muted">
            {t("decoderInfo.mux.more", { count: mux.cases.length - 16 })}
          </span>
        )}
      </div>
    </div>
  );
}
