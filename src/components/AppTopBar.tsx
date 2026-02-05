// ui/src/components/AppTopBar.tsx
//
// Unified top bar component for apps. Renders common sections (icon, IO session
// controls, frame picker) via props, with slots for custom content and actions.

import { type ReactNode } from "react";
import { ChevronRight, ListFilter, type LucideIcon } from "lucide-react";
import { IOSessionControls, type IOSessionControlsProps } from "./SessionControls";
import FlexSeparator from "./FlexSeparator";
import { buttonBase } from "../styles/buttonStyles";
import { iconLg, iconSm } from "../styles/spacing";
import { bgSurface, borderDivider } from "../styles/colourTokens";

/**
 * IO Session section props - passed to IOSessionControls.
 * Omit onOpenIoReaderPicker from the type since it's required in IOSessionControlsProps
 * but we'll handle it in AppTopBar.
 */
export type IOSessionSectionProps = Omit<IOSessionControlsProps, "isStreaming"> & {
  isStreaming?: boolean;
};

/**
 * Frame picker section props.
 */
export interface FramePickerSectionProps {
  /** Total number of frames */
  frameCount: number;
  /** Number of selected frames */
  selectedCount: number;
  /** Click handler to open frame picker */
  onOpen: () => void;
  /** Whether button should be disabled */
  disabled?: boolean;
  /** Title to show when disabled */
  disabledTitle?: string;
}

export interface AppTopBarProps {
  // === Identity (required) ===
  /** Lucide icon component */
  icon: LucideIcon;
  /** Icon colour class (e.g., "text-purple-600 dark:text-purple-400") */
  iconColour: string;
  /** Optional title text (for Settings-style with label) */
  title?: string;

  // === IO Session Section (optional) ===
  /** If provided, renders IOSessionControls with these props */
  ioSession?: IOSessionSectionProps;

  // === Frame Picker Section (optional) ===
  /** If provided, renders a frame picker button */
  framePicker?: FramePickerSectionProps;

  // === Custom Content ===
  /** Content rendered after standard sections, before actions */
  children?: ReactNode;

  // === Right-side Actions ===
  /** Content rendered at the right side of the bar */
  actions?: ReactNode;
}

/**
 * Unified top bar component for apps.
 *
 * Renders sections in this order:
 * 1. Icon (+ title if provided)
 * 2. FlexSeparator
 * 3. IOSessionControls (if `ioSession` provided)
 * 4. ChevronRight + FramePickerButton (if `framePicker` provided)
 * 5. Children (custom content)
 * 6. FlexSeparator
 * 7. Actions
 *
 * @example
 * ```tsx
 * <AppTopBar
 *   icon={Search}
 *   iconColour="text-purple-600 dark:text-purple-400"
 *   ioSession={{
 *     ioProfile,
 *     ioProfiles,
 *     isStreaming,
 *     onOpenIoReaderPicker: () => dialogs.ioReaderPicker.open(),
 *   }}
 *   framePicker={{
 *     frameCount: frameList.length,
 *     selectedCount: selectedFrames.size,
 *     onOpen: () => dialogs.framePicker.open(),
 *   }}
 *   actions={<>Save/Export buttons</>}
 * >
 *   <ToolsButton />
 * </AppTopBar>
 * ```
 */
export default function AppTopBar({
  icon: Icon,
  iconColour,
  title,
  ioSession,
  framePicker,
  children,
  actions,
}: AppTopBarProps) {
  const hasActions = !!actions;

  return (
    <div className={`flex-shrink-0 ${bgSurface} ${borderDivider} px-4 py-2`}>
      <div className="flex flex-wrap items-center gap-2">
        {/* Icon */}
        <Icon className={`${iconLg} ${iconColour} shrink-0`} />

        {/* Title (if provided) */}
        {title && (
          <span className="font-semibold text-[color:var(--text-primary)]">
            {title}
          </span>
        )}

        {/* Separator after icon/title */}
        <FlexSeparator />

        {/* IO Session Controls (if provided) */}
        {ioSession && (
          <IOSessionControls
            ioProfile={ioSession.ioProfile}
            ioProfiles={ioSession.ioProfiles}
            multiBusProfiles={ioSession.multiBusProfiles}
            bufferMetadata={ioSession.bufferMetadata}
            defaultReadProfileId={ioSession.defaultReadProfileId}
            sessionId={ioSession.sessionId}
            ioState={ioSession.ioState}
            onOpenIoReaderPicker={ioSession.onOpenIoReaderPicker}
            speed={ioSession.speed}
            supportsSpeed={ioSession.supportsSpeed}
            onOpenSpeedPicker={ioSession.onOpenSpeedPicker}
            isStreaming={ioSession.isStreaming ?? false}
            isStopped={ioSession.isStopped}
            supportsTimeRange={ioSession.supportsTimeRange}
            onStop={ioSession.onStop}
            onResume={ioSession.onResume}
            onLeave={ioSession.onLeave}
            onOpenBookmarkPicker={ioSession.onOpenBookmarkPicker}
            hideSessionControls={ioSession.hideSessionControls}
          />
        )}

        {/* Frame Picker (if provided) */}
        {framePicker && (
          <>
            <ChevronRight className={`${iconSm} text-[color:var(--text-muted)] shrink-0`} />
            <button
              onClick={framePicker.onOpen}
              disabled={framePicker.disabled}
              className={buttonBase}
              title={
                framePicker.disabled && framePicker.disabledTitle
                  ? framePicker.disabledTitle
                  : "Select frames"
              }
            >
              <ListFilter className={`${iconSm} flex-shrink-0`} />
              <span className="text-[color:var(--text-muted)]">
                {framePicker.selectedCount}/{framePicker.frameCount}
              </span>
            </button>
          </>
        )}

        {/* Custom content */}
        {children}

        {/* Separator before actions (only if there are actions) */}
        {hasActions && <FlexSeparator />}

        {/* Actions */}
        {actions}
      </div>
    </div>
  );
}
