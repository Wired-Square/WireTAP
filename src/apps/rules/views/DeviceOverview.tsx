// Copyright 2026 Wired Square Pty Ltd
// SPDX-License-Identifier: Apache-2.0
//
// Device overview — horizontal flow diagram showing the relationship
// between interfaces, frame defs, bridges, transformers, generators,
// and device signals.

import { useCallback } from "react";
import { useShallow } from "zustand/react/shallow";
import { useRulesStore, type RulesTab } from "../stores/rulesStore";
import { textPrimary, textSecondary, textTertiary, borderDefault } from "../../../styles";
import { cardDefault, cardPadding } from "../../../styles/cardStyles";
import { formatHexId } from "../utils/formatHex";

export default function DeviceOverview() {
  const { frameDefs, bridges, transformers, generators, device, temporaryRules, setActiveTab, selectItem } =
    useRulesStore(
      useShallow((s) => ({
        frameDefs: s.frameDefs,
        bridges: s.bridges,
        transformers: s.transformers,
        generators: s.generators,
        device: s.device,
        temporaryRules: s.temporaryRules,
        setActiveTab: s.setActiveTab,
        selectItem: s.selectItem,
      })),
    );

  const interfaces = device?.interfaces ?? [];

  const navigateTo = useCallback(
    (tab: RulesTab, itemId?: string) => {
      if (itemId) selectItem(itemId);
      setActiveTab(tab);
    },
    [setActiveTab, selectItem],
  );

  return (
    <div className="space-y-4">
      {/* Resource summary bar */}
      <div className={`${cardDefault} ${cardPadding.sm} flex items-center gap-4 text-xs`}>
        <ResourceCount label="Interfaces" count={interfaces.length} />
        <ResourceCount label="Frame Defs" count={frameDefs.length} />
        <ResourceCount label="Bridges" count={bridges.length} />
        <ResourceCount label="Transformers" count={transformers.length} />
        <ResourceCount label="Generators" count={generators.length} />
        <span className={`ml-auto text-xs ${textTertiary}`}>
          {temporaryRules.size} temporary rule{temporaryRules.size !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Flow diagram */}
      <div className="relative min-h-[300px]">
        <div className="flex items-start gap-6 overflow-x-auto p-4">
          {/* Interfaces column */}
          <Column title="Interfaces">
            {interfaces.map((iface) => (
              <FlowCard
                key={iface.index}
                label={iface.name}
                sublabel={`Index ${iface.index}`}
                borderClass="border-blue-500/40"
              />
            ))}
          </Column>

          {/* Arrow */}
          <Arrow />

          {/* Frame Defs column */}
          <Column title="Frame Defs">
            {frameDefs.map((fd) => {
              const isTemp = temporaryRules.has(`framedef:${fd.frame_def_id}`);
              return (
                <FlowCard
                  key={fd.frame_def_id}
                  label={fd.name}
                  sublabel={
                    fd.can_id != null
                      ? `0x${fd.can_id.toString(16).toUpperCase()}`
                      : fd.interface_type_name
                  }
                  borderClass={isTemp ? "border-amber-500/40 border-dashed" : "border-green-500/40"}
                  onClick={() => navigateTo("frame-defs", `framedef:${fd.frame_def_id}`)}
                />
              );
            })}
            {frameDefs.length === 0 && <EmptyCard />}
          </Column>

          {/* Arrow */}
          <Arrow />

          {/* Processing column */}
          <Column title="Processing">
            {bridges.map((b) => {
              const isTemp = temporaryRules.has(`bridge:${b.bridge_id}`);
              return (
                <FlowCard
                  key={`b-${b.bridge_id}`}
                  label={`Bridge ${formatHexId(b.bridge_id)}`}
                  sublabel={`${b.source_interface_name}→${b.dest_interface_name}`}
                  borderClass={
                    !b.enabled
                      ? "border-neutral-500/30 opacity-50"
                      : isTemp
                        ? "border-amber-500/40 border-dashed"
                        : "border-green-500/40"
                  }
                  onClick={() => navigateTo("bridges", `bridge:${b.bridge_id}`)}
                />
              );
            })}
            {transformers.map((t) => {
              const isTemp = temporaryRules.has(`xform:${t.transformer_id}`);
              return (
                <FlowCard
                  key={`x-${t.transformer_id}`}
                  label={`Xform ${formatHexId(t.transformer_id)}`}
                  sublabel={`${t.source_frame_def_name}→${t.dest_frame_def_name}`}
                  borderClass={
                    !t.enabled
                      ? "border-neutral-500/30 opacity-50"
                      : isTemp
                        ? "border-amber-500/40 border-dashed"
                        : "border-green-500/40"
                  }
                  onClick={() => navigateTo("transformers", `xform:${t.transformer_id}`)}
                />
              );
            })}
            {generators.map((g) => {
              const isTemp = temporaryRules.has(`gen:${g.generator_id}`);
              return (
                <FlowCard
                  key={`g-${g.generator_id}`}
                  label={`Gen ${formatHexId(g.generator_id)}`}
                  sublabel={`${g.frame_def_name}→${g.interface_name}`}
                  borderClass={
                    !g.enabled
                      ? "border-neutral-500/30 opacity-50"
                      : isTemp
                        ? "border-amber-500/40 border-dashed"
                        : "border-green-500/40"
                  }
                  onClick={() => navigateTo("generators", `gen:${g.generator_id}`)}
                />
              );
            })}
            {bridges.length === 0 && transformers.length === 0 && generators.length === 0 && (
              <EmptyCard />
            )}
          </Column>

          {/* Arrow */}
          <Arrow />

          {/* Output column */}
          <Column title="Outputs">
            {interfaces.map((iface) => (
              <FlowCard
                key={`out-${iface.index}`}
                label={iface.name}
                sublabel="Output"
                borderClass="border-purple-500/40"
              />
            ))}
            <FlowCard
              label="Device Signals"
              sublabel="Signal store"
              borderClass="border-cyan-500/40"
            />
          </Column>
        </div>
      </div>
    </div>
  );
}

function Column({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 min-w-[140px]">
      <span className={`text-xs font-medium ${textSecondary} text-center`}>{title}</span>
      {children}
    </div>
  );
}

function FlowCard({
  label,
  sublabel,
  borderClass,
  onClick,
}: {
  label: string;
  sublabel: string;
  borderClass: string;
  onClick?: () => void;
}) {
  const clickable = !!onClick;
  return (
    <div
      className={`px-3 py-2 rounded-lg border-2 ${borderClass} bg-[var(--bg-surface)] text-center ${clickable ? "cursor-pointer hover:brightness-125 transition-all" : ""}`}
      onClick={onClick}
    >
      <div className={`text-xs font-medium ${textPrimary}`}>{label}</div>
      <div className={`text-[10px] ${textTertiary}`}>{sublabel}</div>
    </div>
  );
}

function Arrow() {
  return (
    <div className={`flex items-center self-center ${textTertiary}`}>
      <svg width="24" height="12" viewBox="0 0 24 12">
        <line x1="0" y1="6" x2="18" y2="6" stroke="currentColor" strokeWidth="1.5" />
        <polygon points="18,2 24,6 18,10" fill="currentColor" />
      </svg>
    </div>
  );
}

function EmptyCard() {
  return (
    <div className={`px-3 py-2 rounded-lg border border-dashed ${borderDefault} text-center`}>
      <span className={`text-[10px] ${textTertiary}`}>None</span>
    </div>
  );
}

function ResourceCount({ label, count }: { label: string; count: number }) {
  return (
    <span className={textSecondary}>
      <span className={textPrimary}>{count}</span> {label}
    </span>
  );
}
