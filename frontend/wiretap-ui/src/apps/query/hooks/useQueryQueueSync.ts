// src/apps/query/hooks/useQueryQueueSync.ts

import { useEffect } from "react";
import { useQueryStore } from "../stores/queryStore";
import { wsTransport } from "../../../services/wsTransport";
import { MsgType, decodeWsJson } from "../../../services/wsProtocol";
import { getQueryQueue, type QueryQueue } from "../../../api/query";

/** Keeps this window's view of the Query queue level with Rust's: read on mount and reconnect, then each push. */
export function useQueryQueueSync(): void {
  useEffect(() => {
    const catchUp = () => {
      getQueryQueue().then(useQueryStore.getState().applyQueue).catch(() => {});
    };
    catchUp();
    const offPush = wsTransport.onGlobalMessage(MsgType.QueryQueue, (_payload, raw) => {
      useQueryStore.getState().applyQueue(decodeWsJson<QueryQueue>(raw));
    });
    const offReconnect = wsTransport.onReconnect(catchUp);
    return () => {
      offPush();
      offReconnect();
    };
  }, []);
}
