import { describe, it, expect } from "vitest";
import { getStateType } from "../api/io";
import { sessionStatus } from "../utils/sessionStatus";

describe("sessionStatus", () => {
  it("shows an errored session with a red dot and a danger label", () => {
    const errored = sessionStatus(getStateType({ type: "Error", message: "port vanished" }));
    expect(errored).toEqual({ label: "Error", dotColour: "bg-danger-text", textColour: "text-danger" });
  });
});
