import { describe, expect, it } from "vitest";
import { renderReport } from "../utils/reportExport";

describe("renderReport", () => {
  const render = async (format: string) => (format === "html" ? "<h1>Body</h1>\n" : `rendered as ${format}`);

  it("passes text and Markdown through as Rust renders them", async () => {
    expect(await renderReport("text", "T", render)).toBe("rendered as text");
    expect(await renderReport("markdown", "T", render)).toBe("rendered as markdown");
  });

  it("wraps Rust's HTML body in the chosen theme", async () => {
    const screen = await renderReport("html-screen", "A & B", render);
    expect(screen).toContain("<title>A &amp; B</title>");
    expect(screen).toContain("<h1>Body</h1>");
    expect(screen).not.toContain("print-instructions\">");
    expect(await renderReport("html-print", "T", render)).toContain('<div class="print-instructions">');
  });
});
