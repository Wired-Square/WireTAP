// Copyright 2026 Wired Square Pty Ltd

import { listOrphanedCaptures } from "../api/capture";
import { useCaptureListStore } from "../stores/captureListStore";
import { useWsResync } from "./useWsResync";
import { MsgType } from "../services/wsProtocol";

export function useCaptureListSync(): void {
  useWsResync(MsgType.CaptureListChanged, () => {
    listOrphanedCaptures()
      .then((orphaned) => useCaptureListStore.setState({ orphaned }))
      .catch(() => {});
  });
}
