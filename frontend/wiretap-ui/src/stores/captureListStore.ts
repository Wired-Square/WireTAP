// Copyright 2026 Wired Square Pty Ltd
//
// The captures no session owns, which the source picker offers. Rust pushes
// CaptureListChanged whenever the list moves; `useCaptureListSync` re-reads it.

import { create } from "zustand";
import type { CaptureMetadata } from "../api/capture";

export const useCaptureListStore = create<{ orphaned: CaptureMetadata[] }>(() => ({ orphaned: [] }));
