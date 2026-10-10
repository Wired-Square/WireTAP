import { describe, it, expect, beforeEach } from "vitest";
import { useQueryStore } from "../apps/query/stores/queryStore";
import type { Catalog, Frame } from "../types/catalogModel";

const frame = (frameId: number, isExtended = false) =>
  ({ key: `0x${frameId.toString(16)}`, frameId, protocol: "can", length: 8, isExtended, signals: [] }) as Frame;
const catalog = (...frames: Frame[]) => ({ meta: { name: "c", version: 1 }, protocol: "can", frames }) as unknown as Catalog;

const params = () => useQueryStore.getState().queryParams;

describe("the Query frame select and the state agree", () => {
  beforeEach(() => {
    useQueryStore.setState({ catalog: null, queryParams: { ...params(), frameId: 0, isExtended: null } });
  });

  it("a loaded catalogue selects its first frame, as the select shows", () => {
    useQueryStore.getState().setCatalog(catalog(frame(0x200), frame(0x18ff0001, true), frame(0x100)));
    expect(params()).toMatchObject({ frameId: 0x100, isExtended: false });
  });

  it("a frame the catalogue has stays selected", () => {
    useQueryStore.setState({ queryParams: { ...params(), frameId: 0x200, isExtended: false } });
    useQueryStore.getState().setCatalog(catalog(frame(0x100), frame(0x200)));
    expect(params().frameId).toBe(0x200);
  });

  it("a catalogue with no frames leaves the typed frame alone", () => {
    useQueryStore.setState({ queryParams: { ...params(), frameId: 0x123 } });
    useQueryStore.getState().setCatalog(catalog());
    expect(params().frameId).toBe(0x123);
  });
});
