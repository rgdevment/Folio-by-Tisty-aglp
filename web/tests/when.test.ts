import { describe, expect, it } from "vitest";
import { ago, day } from "../src/when";

// 30 October 2026, 12:00 UTC; the tests run in UTC (vite.config.ts).
const NOW = 1_793_361_600;

describe("a date", () => {
  it("reads in the reader's language", () => {
    expect(day(NOW, "es")).toBe("30 de octubre de 2026");
    expect(day(NOW, "en")).toBe("October 30, 2026");
  });
});

describe("how long ago", () => {
  it("takes the largest step that fits", () => {
    expect(ago(NOW - 3 * 3_600, NOW, "es")).toBe("hace 3 horas");
    expect(ago(NOW - 86_400, NOW, "en")).toBe("yesterday");
    expect(ago(NOW - 20 * 86_400, NOW, "en")).toBe("2 weeks ago");
    expect(ago(NOW - 400 * 86_400, NOW, "es")).toBe("el año pasado");
  });

  it("calls anything under a minute now, and a clock running ahead too", () => {
    expect(ago(NOW - 20, NOW, "en")).toBe("this minute");
    expect(ago(NOW + 90, NOW, "en")).toBe("this minute");
  });
});
