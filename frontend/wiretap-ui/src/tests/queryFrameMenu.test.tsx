import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Catalog, Frame } from "../types/catalogModel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => null) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(async () => () => {}) }));

const { default: QueryBuilderPanel } = await import("../apps/query/views/QueryBuilderPanel");
const { useQueryStore } = await import("../apps/query/stores/queryStore");

const frame = (frameId: number, extra: Partial<Frame>) =>
  ({ key: `0x${frameId.toString(16)}`, frameId, protocol: "can", length: 8, isExtended: false, signals: [], ...extra }) as Frame;

const optionTexts = () =>
  [...renderToStaticMarkup(
    createElement(QueryBuilderPanel, {
      profileId: "p",
      timeBounds: {} as never,
      onTimeBoundsChange: () => {},
      displayIdFormat: "hex",
    }),
  ).matchAll(/<option[^>]*>(.*?)<\/option>/g)].map((m) => m[1].replace(/<!-- -->/g, ""));

describe("the Query frame menu", () => {
  it("labels a frame by its name, else by its transmitter", () => {
    useQueryStore.getState().setCatalog({
      meta: { name: "c", version: 1 },
      protocol: "can",
      frames: [frame(0x0c0, { name: "Engine status", transmitter: "ECM" }), frame(0x0c1, { transmitter: "BCM" })],
    } as unknown as Catalog);
    const options = optionTexts();
    expect(options.find((o) => o.includes("0C0"))).toMatch(/— Engine status$/);
    expect(options.find((o) => o.includes("0C1"))).toMatch(/— BCM$/);
  });
});
