import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { formatValue } from "../apps/dashboard/utils/dashboardFormat";

type Vector = { input: string; output: string };

function magnitudeVectors(): Vector[] {
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--locked"], {
      cwd: join(__dirname, "../../../.."),
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as { packages: { name: string; manifest_path: string }[] };
  const crate = metadata.packages.find((p) => p.name === "wslib-quantity");
  if (!crate) throw new Error("wslib-quantity is not in the Cargo graph");
  return JSON.parse(readFileSync(join(dirname(crate.manifest_path), "tests/vectors/magnitude.json"), "utf8"));
}

const significantDigits = (decimal: string) => decimal.replace(/[-.]/g, "").replace(/^0+/, "").replace(/0+$/, "").length;
const fitsInADouble = (v: Vector) => significantDigits(v.input) <= 17;

describe("formatValue matches wslib-quantity's magnitude vectors", () => {
  const vectors = magnitudeVectors();

  it.each(vectors.filter(fitsInADouble))("$input reads $output", ({ input, output }) => {
    expect(formatValue(Number(input))).toBe(output);
  });

  it("skips only the inputs a double cannot hold", () => {
    expect(vectors.filter((v) => !fitsInADouble(v)).map((v) => v.input)).toEqual([
      "79228162514264337593543950335",
      "-79228162514264337593543950335",
      "7922816251426433759354395033.5",
    ]);
  });
});
