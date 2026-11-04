import { describe, it, expect } from "vitest";
import { generatePseudo, pseudoTree, readPseudo } from "../../scripts/gen-pseudo.mjs";
import { NAMESPACES, PICKER_LANGUAGES, PSEUDO_LANGUAGE, resources } from "../locales";

describe("xx-PS pseudo-locale", () => {
  it("is what npm run gen:pseudo writes", () => {
    const generated = generatePseudo();
    expect(Object.keys(generated).sort()).toEqual(NAMESPACES.map((ns) => `${ns}.json`).sort());
    expect(readPseudo(), "src/locales/xx-PS/ is stale: run `npm run gen:pseudo`").toEqual(generated);
  });

  it("is offered and loaded in a dev build", () => {
    expect(PICKER_LANGUAGES).toContain(PSEUDO_LANGUAGE);
    expect(Object.keys((resources as Record<string, object>)[PSEUDO_LANGUAGE]).sort()).toEqual([...NAMESPACES].sort());
  });

  it("wraps every string, keeping placeholders and nestings", () => {
    expect(
      pseudoTree({
        title: "Frames",
        count_one: "{{count}} frame",
        nested: { hint: "$t(common:actions.save) to {{target}}", list: ["a"] },
        limit: 5,
        flag: true,
        none: null,
      }),
    ).toEqual({
      title: "⟦Frames⟧",
      count_one: "⟦{{count}} frame⟧",
      nested: { hint: "⟦$t(common:actions.save) to {{target}}⟧", list: ["⟦a⟧"] },
      limit: 5,
      flag: true,
      none: null,
    });
  });
});
