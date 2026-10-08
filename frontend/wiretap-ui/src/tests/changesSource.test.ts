import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../stores/discoveryUIStore", () => ({ useDiscoveryUIStore: { getState: () => ({}) } }));

import { changesCapture } from "../stores/discoveryToolboxStore";

const selection = [{ protocol: "can", frame_ids: [0x100], all_ids: false }];

describe("the capture Payload Changes reads", () => {
  it("is the session's whenever it has one, live or not", () => {
    expect(changesCapture(false, "c1", selection)).toEqual({ captureId: "c1", selection });
  });

  it("is none without a session capture", () => {
    expect(changesCapture(false, null, selection)).toBeUndefined();
  });

  it("is none for serial frames, which are framed on the client", () => {
    expect(changesCapture(true, "c1", selection)).toBeUndefined();
  });
});
