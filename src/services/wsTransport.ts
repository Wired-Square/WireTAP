// src/services/wsTransport.ts
//
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Wired Square Pty Ltd
//
// Singleton WebSocket transport service. Manages connection lifecycle,
// authentication, channel subscriptions, and message dispatching for
// the binary WS protocol.

import { invoke } from "@tauri-apps/api/core";
import {
  decodeHeader,
  decodeSessionError,
  decodeSubscribeAck,
  encodeAuth,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeHeartbeat,
  MsgType,
  HEADER_SIZE,
} from "./wsProtocol";
import { trackAlloc } from "./memoryDiag";

interface WsConfig {
  port: number;
  token: string;
}

type MessageHandler = (payload: DataView, raw: ArrayBuffer) => void;

class WsTransport {
  private ws: WebSocket | null = null;
  private port: number = 0;
  private token: string = "";
  private connected: boolean = false;
  private authenticated: boolean = false;

  // channel <-> sessionId mapping
  private channelToSession: Map<number, string> = new Map();
  private sessionToChannel: Map<string, number> = new Map();

  // Pending subscribe promises
  private pendingSubscribes: Map<
    string,
    { resolve: (channel: number) => void; reject: (err: Error) => void }
  > = new Map();

  // Message handlers: Map<channel, Map<msgType, handler[]>>
  private handlers: Map<number, Map<number, MessageHandler[]>> = new Map();

  // Handlers registered before subscribe completes (keyed by sessionId)
  // Wired up to the channel when SubscribeAck arrives.
  private pendingHandlers: Map<string, { msgType: number; handler: MessageHandler }[]> =
    new Map();

  // Global handlers (channel 0)
  private globalHandlers: Map<number, MessageHandler[]> = new Map();

  // Reconnect state
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay: number = 1000;
  private shouldReconnect: boolean = true;

  // Heartbeat
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  /** Connect to the WS server. Call once at app startup. */
  async connect(): Promise<void> {
    const config = await invoke<WsConfig>("get_ws_config");
    this.port = config.port;
    this.token = config.token;
    return this.doConnect();
  }

  private doConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${this.port}`);
      ws.binaryType = "arraybuffer";

      ws.onopen = () => {
        this.ws = ws;
        this.connected = true;
        this.reconnectDelay = 1000;
        // Send auth — don't resolve until server acks
        ws.send(encodeAuth(this.token));
      };

      ws.onmessage = (event: MessageEvent) => {
        const buf = event.data as ArrayBuffer;
        // Check for Auth ack (server echoes Auth with empty payload on success)
        if (!this.authenticated && buf.byteLength >= HEADER_SIZE) {
          const header = decodeHeader(buf);
          if (header.msgType === MsgType.Auth) {
            this.authenticated = true;
            this.startHeartbeat();
            console.log("[wsTransport] Authenticated");
            resolve();
            return;
          }
        }
        this.handleMessage(buf);
      };

      ws.onclose = () => {
        this.connected = false;
        this.authenticated = false;
        this.stopHeartbeat();
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        if (!this.connected) reject(new Error("WebSocket connection failed"));
      };
    });
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    this.shouldReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  /** Subscribe to a session's events. Returns the assigned channel number. */
  async subscribe(sessionId: string): Promise<number> {
    if (this.sessionToChannel.has(sessionId)) {
      return this.sessionToChannel.get(sessionId)!;
    }

    return new Promise((resolve, reject) => {
      this.pendingSubscribes.set(sessionId, { resolve, reject });
      this.ws?.send(encodeSubscribe(sessionId));
      // Timeout after 5 seconds
      setTimeout(() => {
        if (this.pendingSubscribes.has(sessionId)) {
          this.pendingSubscribes.delete(sessionId);
          reject(new Error("Subscribe timeout"));
        }
      }, 5000);
    });
  }

  /** Unsubscribe from a session. */
  unsubscribe(sessionId: string): void {
    const channel = this.sessionToChannel.get(sessionId);
    if (channel === undefined) return;
    this.ws?.send(encodeUnsubscribe(channel));
    this.channelToSession.delete(channel);
    this.sessionToChannel.delete(sessionId);
    this.handlers.delete(channel);
    this.pendingHandlers.delete(sessionId);
  }

  /**
   * Register a handler for a session-scoped message type.
   * Returns an unlisten function.
   */
  onSessionMessage(
    sessionId: string,
    msgType: number,
    handler: MessageHandler,
  ): () => void {
    const channel = this.sessionToChannel.get(sessionId);

    if (channel === undefined) {
      // Channel not assigned yet — queue for when SubscribeAck arrives
      if (!this.pendingHandlers.has(sessionId))
        this.pendingHandlers.set(sessionId, []);
      this.pendingHandlers.get(sessionId)!.push({ msgType, handler });

      return () => {
        const pending = this.pendingHandlers.get(sessionId);
        if (pending) {
          const idx = pending.findIndex((p) => p.handler === handler);
          if (idx >= 0) pending.splice(idx, 1);
        }
      };
    }

    if (!this.handlers.has(channel))
      this.handlers.set(channel, new Map());
    const channelHandlers = this.handlers.get(channel)!;
    if (!channelHandlers.has(msgType)) channelHandlers.set(msgType, []);
    channelHandlers.get(msgType)!.push(handler);

    return () => {
      const arr = channelHandlers.get(msgType);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  /**
   * Register a handler for a global message type (channel 0).
   * Returns an unlisten function.
   */
  onGlobalMessage(msgType: number, handler: MessageHandler): () => void {
    if (!this.globalHandlers.has(msgType))
      this.globalHandlers.set(msgType, []);
    this.globalHandlers.get(msgType)!.push(handler);

    return () => {
      const arr = this.globalHandlers.get(msgType);
      if (arr) {
        const idx = arr.indexOf(handler);
        if (idx >= 0) arr.splice(idx, 1);
      }
    };
  }

  /** Whether the transport is connected and authenticated. */
  get isConnected(): boolean {
    return this.connected && this.authenticated;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private handleMessage(buf: ArrayBuffer): void {
    if (buf.byteLength < HEADER_SIZE) return;
    trackAlloc("ws.receive", buf.byteLength);
    const header = decodeHeader(buf);

    // Handle protocol-level messages
    switch (header.msgType) {
      case MsgType.SubscribeAck:
        this.handleSubscribeAck(buf);
        return;
      case MsgType.SubscribeNack:
        this.handleSubscribeNack(buf);
        return;
      case MsgType.Heartbeat:
        this.ws?.send(encodeHeartbeat());
        return;
    }

    // Dispatch to registered handlers
    const payload = new DataView(buf, HEADER_SIZE);
    if (header.channel === 0) {
      const handlers = this.globalHandlers.get(header.msgType);
      if (handlers) {
        for (const h of handlers) h(payload, buf);
      }
    } else {
      const channelHandlers = this.handlers.get(header.channel);
      if (channelHandlers) {
        const handlers = channelHandlers.get(header.msgType);
        if (handlers) {
          for (const h of handlers) h(payload, buf);
        }
      }
    }
  }

  private handleSubscribeAck(buf: ArrayBuffer): void {
    const payload = new DataView(buf, HEADER_SIZE);
    const { channel, sessionId } = decodeSubscribeAck(payload);

    this.channelToSession.set(channel, sessionId);
    this.sessionToChannel.set(sessionId, channel);

    // Wire up any handlers that were registered before the channel was assigned
    const pendingH = this.pendingHandlers.get(sessionId);
    if (pendingH) {
      if (!this.handlers.has(channel)) this.handlers.set(channel, new Map());
      const channelHandlers = this.handlers.get(channel)!;
      for (const { msgType, handler } of pendingH) {
        if (!channelHandlers.has(msgType)) channelHandlers.set(msgType, []);
        channelHandlers.get(msgType)!.push(handler);
      }
      this.pendingHandlers.delete(sessionId);
    }

    const pending = this.pendingSubscribes.get(sessionId);
    if (pending) {
      pending.resolve(channel);
      this.pendingSubscribes.delete(sessionId);
    }
  }

  private handleSubscribeNack(buf: ArrayBuffer): void {
    const payload = new Uint8Array(buf, HEADER_SIZE);
    const error = decodeSessionError(payload);

    // Reject the first pending subscribe (SubscribeNack doesn't carry session ID)
    for (const [sid, pending] of this.pendingSubscribes) {
      pending.reject(new Error(error));
      this.pendingSubscribes.delete(sid);
      break;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.doConnect();
        // Save session IDs, then clear all stale channel mappings.
        // The old channel numbers are invalid after reconnect; the server
        // will assign new ones via SubscribeAck.
        const sessionIds = [...this.sessionToChannel.keys()];
        this.channelToSession.clear();
        this.sessionToChannel.clear();
        this.handlers.clear();
        this.pendingHandlers.clear();
        // Re-subscribe all sessions
        for (const sessionId of sessionIds) {
          this.ws?.send(encodeSubscribe(sessionId));
        }
      } catch {
        // Exponential backoff: 1s, 2s, 4s, 8s, ..., max 30s
        this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
        this.scheduleReconnect();
      }
    }, this.reconnectDelay);
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    // 10s interval keeps IO listener heartbeats fresh (30s watchdog timeout).
    // Each heartbeat also bridges to the IO session watchdog via the Rust
    // WS server, so the frontend no longer needs per-listener invoke polling.
    this.heartbeatTimer = setInterval(() => {
      if (this.connected) {
        this.ws?.send(encodeHeartbeat());
      }
    }, 10000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}

// Singleton instance
export const wsTransport = new WsTransport();

/** Initialise WebSocket transport. Call once at app startup. */
export async function initWsTransport(): Promise<void> {
  try {
    await wsTransport.connect();
    console.log("[wsTransport] Connected to binary transport server");
  } catch (e) {
    console.warn("[wsTransport] Failed to connect:", e);
    // Non-fatal -- app works without WS (Tauri events are fallback)
  }
}
