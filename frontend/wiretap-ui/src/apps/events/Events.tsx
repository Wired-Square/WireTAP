// src/apps/events/Events.tsx
//
// Events — what happened, when, against the joined session's stored capture.
// The scrubber above the list carries every event as a marker; the list edits them.

import { useEffect, useMemo, useState } from "react";
import { Flag } from "lucide-react";
import { useTranslation } from "react-i18next";
import AppLayout from "../../components/AppLayout";
import AppTabView from "../../components/AppTabView";
import AppTopBar from "../../components/AppTopBar";
import { Alert } from "../../components/Alert";
import { Button } from "../../components/Button";
import ConfirmDeleteDialog from "../../dialogs/ConfirmDeleteDialog";
import EventDialog from "../../dialogs/EventDialog";
import IoSourcePickerDialog from "../../dialogs/IoSourcePickerDialog";
import { useAllIOProfiles } from "../../hooks/useAllIOProfiles";
import { useDialogManager } from "../../hooks/useDialogManager";
import { useEffectiveCaptureMetadata } from "../../hooks/useEffectiveCaptureMetadata";
import { useIOSessionManager } from "../../hooks/useIOSessionManager";
import { useIOSourcePickerHandlers } from "../../hooks/useIOSourcePickerHandlers";
import { useMenuSessionControl } from "../../hooks/useMenuSessionControl";
import { useSessionEvents } from "../../hooks/useSessionEvents";
import { useSettings } from "../../hooks/useSettings";
import { emptyStateContainer, emptyStateDescription, emptyStateHeading, emptyStateText } from "../../styles/typography";
import { textSecondary } from "../../styles/colourTokens";
import { deleteCaptureEvent, type CaptureEvent } from "../../api/captureEvents";
import { getCaptureMetadataById, type CaptureMetadata } from "../../api/capture";
import EventListView from "./views/EventListView";

export default function Events() {
  const { t } = useTranslation("events");
  const { settings } = useSettings();
  const ioProfiles = useAllIOProfiles();
  const useLocalTimezone = settings?.display_timezone === "local";

  const dialogs = useDialogManager(["ioSessionPicker", "deleteEvent"] as const);
  const [pendingDelete, setPendingDelete] = useState<CaptureEvent | null>(null);
  const [error, setError] = useState<string | null>(null);

  const manager = useIOSessionManager({ appName: "events", ioProfiles, onError: setError });
  const {
    ioProfile,
    ioProfileName,
    multiBusProfiles,
    session,
    isStreaming,
    isPaused,
    isStopped,
    canReturnToLive,
    sessionReady,
    capabilities,
    joinerCount,
    currentTimeUs,
    playheadNowUs,
    eventOwner,
    handleLeave,
    handleDestroy,
    stopWatch,
    resumeWithNewCapture,
    watchFrameCount,
    watchUniqueFrameCount,
    jumpToTimeRange,
  } = manager;
  const { start, stop, leave, pause, resume, seek, captureId, captureStartTimeUs, captureEndTimeUs, captureCount, captureName, capturePersistent } = session;

  const ioPickerProps = useIOSourcePickerHandlers({ manager, closeDialog: () => dialogs.ioSessionPicker.close() });

  // The session reports a capture's range only once it has streamed; the registry knows it now.
  const [localCapture, setLocalCapture] = useState<CaptureMetadata | null>(null);
  useEffect(() => {
    if (!captureId) {
      setLocalCapture(null);
      return;
    }
    let cancelled = false;
    getCaptureMetadataById(captureId).then(
      (meta) => !cancelled && setLocalCapture(meta),
      () => !cancelled && setLocalCapture(null)
    );
    return () => {
      cancelled = true;
    };
  }, [captureId, isStreaming]);
  const capture = useEffectiveCaptureMetadata(
    { captureStartTimeUs, captureEndTimeUs, captureCount, captureName, capturePersistent },
    localCapture
  );
  const rangeStartUs = capture?.start_time_us ?? null;
  const rangeEndUs = capture?.end_time_us ?? null;

  const sessionEvents = useSessionEvents({ owner: eventOwner, capabilities, seek, jumpToTimeRange, useLocalTimezone, onError: setError });
  const { events, error: eventsError, canJump, selectedId, markers, draft, openAdd, openEdit, closeDraft, save } = sessionEvents;

  const openAddAtPlayhead = () => {
    const at = playheadNowUs() ?? rangeStartUs;
    if (eventOwner && at !== null) openAdd(at);
  };

  const handleDelete = async () => {
    dialogs.deleteEvent.close();
    if (!pendingDelete || !eventOwner) return;
    try {
      await deleteCaptureEvent(eventOwner, pendingDelete.id);
      if (selectedId === pendingDelete.id) sessionEvents.setSelectedId(null);
    } catch (e) {
      setError(t("errors.delete", { error: String(e) }));
    }
    setPendingDelete(null);
  };

  useMenuSessionControl({
    panelId: "events",
    sessionState: { profileName: ioProfileName ?? null, isStreaming, isPaused, capabilities, joinerCount },
    callbacks: {
      onPlay: () => {
        if (isPaused) resume();
        else if (isStopped && sessionReady) resumeWithNewCapture();
      },
      onPause: () => {
        if (isStreaming && !isPaused) pause();
      },
      onStop: () => {
        if (isStreaming || isPaused) leave();
      },
      onStopAll: () => {
        if (isStreaming || isPaused) stop();
      },
      onPicker: () => dialogs.ioSessionPicker.open(),
      onEventAdd: openAddAtPlayhead,
      onJumpToEvent: sessionEvents.jumpToEventId,
    },
    events: sessionEvents.menu,
  });

  const canSeek = !!capabilities?.supports_seek;
  const timeline = useMemo(() => {
    if (rangeStartUs == null || rangeEndUs == null || rangeEndUs <= rangeStartUs) return undefined;
    return {
      minTimeUs: rangeStartUs,
      maxTimeUs: rangeEndUs,
      currentTimeUs: currentTimeUs ?? rangeStartUs,
      onScrub: (timeUs: number) => void seek(timeUs),
      displayTimeFormat: "human" as const,
      disabled: !canSeek,
      useLocalTimezone,
      markers,
    };
  }, [rangeStartUs, rangeEndUs, currentTimeUs, seek, canSeek, useLocalTimezone, markers]);

  const banner = error ?? (eventsError ? t("errors.load", { error: eventsError }) : null);
  const emptyState = !ioProfile
    ? { heading: t("empty.noSession"), hint: t("empty.noSessionHint") }
    : !eventOwner
      ? { heading: t("empty.noOwner"), hint: t("empty.noOwnerHint") }
      : events.length === 0
        ? { heading: t("empty.noEvents"), hint: t("empty.noEventsHint") }
        : null;

  return (
    <AppLayout
      topBar={
        <AppTopBar
          app="events"
          ioSession={{
            ioProfile,
            ioProfiles,
            multiBusProfiles: session.sessionId ? multiBusProfiles : [],
            defaultReadProfileId: settings?.default_read_profile,
            sessionId: session.sessionId,
            ioState: session.state,
            captureMetadata: capture,
            frameCount: watchUniqueFrameCount,
            totalFrameCount: watchFrameCount,
            onOpenIoSessionPicker: () => dialogs.ioSessionPicker.open(),
            isStreaming,
            isPaused,
            isStopped: isStopped || canReturnToLive,
            onPlay: () => (isPaused ? resume() : start()),
            onPause: pause,
            onLeave: handleLeave,
            onStop: isStreaming ? stopWatch : undefined,
            onDestroy: handleDestroy,
          }}
        />
      }
    >
      <AppTabView
        tabs={[{ id: "events", label: t("tabs.list"), count: events.length || undefined }]}
        activeTab="events"
        onTabChange={() => {}}
        protocolLabel={t("title")}
        isStreaming={isStreaming}
        timestamp={currentTimeUs !== null ? currentTimeUs / 1_000_000 : null}
        tabBarControls={
          <Button size="sm" variant="tonal" onClick={openAddAtPlayhead} disabled={!eventOwner}>
            <Flag size={14} />
            {t("actions.addAtPosition")}
          </Button>
        }
        timeline={timeline}
        contentArea={{ wrap: false }}
      >
        {banner && (
          <Alert
            tone="danger"
            banner
            action={
              <Button onClick={() => setError(null)} variant="link" tone="danger" size="sm">
                {t("common:actions.dismiss")}
              </Button>
            }
          >
            {banner}
          </Alert>
        )}
        {emptyState ? (
          <div className={emptyStateContainer}>
            <Flag size={48} className={textSecondary} />
            <div className={emptyStateText}>
              <p className={emptyStateHeading}>{emptyState.heading}</p>
              <p className={emptyStateDescription}>{emptyState.hint}</p>
            </div>
          </div>
        ) : (
          <EventListView
            events={events}
            selectedId={selectedId}
            canJump={canJump}
            useLocalTimezone={useLocalTimezone}
            onSelect={(event) => sessionEvents.setSelectedId(event.id)}
            onJump={sessionEvents.jumpToEvent}
            onEdit={openEdit}
            onDelete={(event) => {
              setPendingDelete(event);
              dialogs.deleteEvent.open();
            }}
          />
        )}
      </AppTabView>

      <IoSourcePickerDialog
        {...ioPickerProps}
        isOpen={dialogs.ioSessionPicker.isOpen}
        onClose={() => dialogs.ioSessionPicker.close()}
        ioProfiles={ioProfiles}
        selectedId={ioProfile ?? null}
        defaultId={settings?.default_read_profile}
        onSelect={() => {}}
      />
      <EventDialog isOpen={draft !== null} initial={draft} onClose={closeDraft} onSave={save} />
      <ConfirmDeleteDialog
        open={dialogs.deleteEvent.isOpen}
        onCancel={() => dialogs.deleteEvent.close()}
        onConfirm={handleDelete}
        title={t("confirmDelete.title")}
        message={t("confirmDelete.message")}
      />
    </AppLayout>
  );
}
