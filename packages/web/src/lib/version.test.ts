import { expect, test } from "bun:test";
import { buildLabel } from "./version";

test("buildLabel uses the device timezone, including date rollover and daylight saving", () => {
  const previous = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    expect(buildLabel("2030-01-15T02:30:00.000Z")).toBe("build 2030-01-14 21:30");
    expect(buildLabel("2030-07-15T02:30:00.000Z")).toBe("build 2030-07-14 22:30");
    process.env.TZ = "Asia/Kolkata";
    expect(buildLabel("2030-01-15T22:45:00.000Z")).toBe("build 2030-01-16 04:15");
    expect(buildLabel("")).toBe("");
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});
