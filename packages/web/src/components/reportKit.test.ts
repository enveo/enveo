





import { describe, expect, test } from "bun:test";
import { gridTicks } from "./reportKit";

describe("gridTicks", () => {
  test("three distinct labels draw three ticks, in max/mid/min draw order", () => {
    const ticks = gridTicks(0, 300, (v) => `$${v}`);
    expect(ticks).toEqual([
      { value: 300, label: "$300" },
      { value: 150, label: "$150" },
      { value: 0, label: "$0" },
    ]);
  });

  test("all three colliding draws exactly one tick — the mid one", () => {
    

    const ticks = gridTicks(0, 100, () => "••••");
    expect(ticks).toEqual([{ value: 50, label: "••••" }]);
  });

  test("min and mid colliding, max distinct: keeps the top and middle lines, drops the floor", () => {
    const ticks = gridTicks(0, 100, (v) => (v <= 60 ? "LOW" : "HIGH"));  
    expect(ticks).toEqual([
      { value: 100, label: "HIGH" },
      { value: 50, label: "LOW" },
    ]);
  });

  test("max and mid colliding, min distinct: keeps the two extremes, drops the middle", () => {
    const ticks = gridTicks(0, 100, (v) => (v >= 40 ? "HIGH" : "LOW"));  
    expect(ticks).toEqual([
      { value: 100, label: "HIGH" },
      { value: 0, label: "LOW" },
    ]);
  });

  test("a flat series (min === max) draws a single tick at the shared value", () => {
    const ticks = gridTicks(100, 100, (v) => `$${v}`);
    expect(ticks).toEqual([{ value: 100, label: "$100" }]);
  });
});
