import { describe, expect, it, vi } from "vitest";
import { billOf, checkSpend, cycleOf, lineOf, type SpendTools, stageOf, type Usage } from "../src/core/spend";
import type { Stage } from "../src/core/store";

const quiet: Usage = { requests: 0, rowsRead: 0, rowsWritten: 0, classA: 0, classB: 0, storedGb: 0 };
const at = (year: number, month: number, day: number, hour = 12) => Date.UTC(year, month - 1, day, hour);
const cycle30 = (day: number) => ({ start: 0, days: 30, day });
// What it takes to reach a bill, through what a flood of reads would really spend.
const costing = (usd: number): Usage => ({ ...quiet, rowsWritten: 50e6 + (usd - 5) * 1e6 });

describe("the bill", () => {
  it("is the plan while everything fits in what it includes", () => {
    expect(
      billOf({ requests: 10e6, rowsRead: 25e9, rowsWritten: 50e6, classA: 1e6, classB: 10e6, storedGb: 10 }),
    ).toBeCloseTo(5);
  });

  it("adds what passes each included amount, at its price", () => {
    expect(billOf({ ...quiet, requests: 11e6 })).toBeCloseTo(5.3);
    expect(billOf({ ...quiet, requests: 16e6 })).toBeCloseTo(5 + 6 * 0.3 + 2 * 0.02);
    expect(billOf({ ...quiet, rowsRead: 26e9 })).toBeCloseTo(6);
    expect(billOf({ ...quiet, rowsWritten: 51e6 })).toBeCloseTo(6);
    expect(billOf({ ...quiet, classA: 2e6 })).toBeCloseTo(9.5);
    expect(billOf({ ...quiet, classB: 11e6 })).toBeCloseTo(5.36);
    expect(billOf({ ...quiet, storedGb: 110 })).toBeCloseTo(6.5);
  });
});

describe("the cycle", () => {
  it("starts on the renewal day, not on the first", () => {
    const after = cycleOf(at(2026, 11, 20), 15);
    expect(after.start).toBe(Date.UTC(2026, 10, 15));
    expect(after.days).toBe(30);
    expect(after.day).toBe(6);
    const before = cycleOf(at(2026, 11, 10), 15);
    expect(before.start).toBe(Date.UTC(2026, 9, 15));
    expect(before.days).toBe(31);
    expect(before.day).toBe(27);
  });

  it("refuses a day it could not count from, so a missing setting never reads as an open service", () => {
    for (const day of [0, 29, Number.NaN, 1.5]) expect(() => cycleOf(at(2026, 11, 20), day)).toThrow("renewal day");
  });

  it("is day 1 on the renewal day itself, and crosses a year", () => {
    expect(cycleOf(at(2026, 11, 15, 0), 15).day).toBe(1);
    const january = cycleOf(at(2027, 1, 3), 15);
    expect(january.start).toBe(Date.UTC(2026, 11, 15));
    expect(january.day).toBe(20);
  });
});

describe("the line", () => {
  it("rises as the decision says", () => {
    expect(lineOf(cycle30(1))).toBe(8);
    expect(lineOf(cycle30(6))).toBe(8);
    expect(lineOf(cycle30(10))).toBe(10);
    expect(lineOf(cycle30(20))).toBe(15);
    expect(lineOf(cycle30(30))).toBe(20);
  });

  it("never lets the bill pass 20 USD on the last day of a long or short cycle", () => {
    expect(lineOf({ start: 0, days: 31, day: 31 })).toBe(20);
    expect(lineOf({ start: 0, days: 28, day: 28 })).toBe(20);
  });
});

describe("the stage", () => {
  it("goes from open to warned, to no uploads and to blocked", () => {
    expect(stageOf(quiet, cycle30(30))).toBe("open");
    expect(stageOf(costing(10), cycle30(30))).toBe("warned");
    expect(stageOf(costing(15), cycle30(30))).toBe("no_uploads");
    expect(stageOf(costing(20), cycle30(30))).toBe("blocked");
  });

  it("cuts uploads at three quarters of today's line, and blocks at it", () => {
    expect(stageOf(costing(5.9), cycle30(1))).toBe("open");
    expect(stageOf(costing(6), cycle30(1))).toBe("no_uploads");
    expect(stageOf(costing(8), cycle30(1))).toBe("blocked");
  });

  it("cuts uploads at the storage ceiling, and keeps reading", () => {
    expect(stageOf({ ...quiet, storedGb: 100 }, cycle30(30))).toBe("no_uploads");
  });

  it("opens again by itself when the line rises past the same bill", () => {
    const attacked = costing(8);
    expect(stageOf(attacked, cycle30(5))).toBe("blocked");
    expect(stageOf(attacked, cycle30(9))).toBe("no_uploads");
    expect(stageOf(attacked, cycle30(24))).toBe("open");
  });
});

describe("checking", () => {
  const NOW = at(2026, 11, 20);
  const RENEWAL = 15;

  const tools = (usage: Usage, was: Stage) => {
    const steps: string[] = [];
    const set: SpendTools = {
      store: {
        stage: async () => was,
        setStage: async (stage) => void steps.push(`stage:${stage}`),
        liftCut: async () => void steps.push("lift"),
      },
      usageSince: async () => usage,
      setBlocked: async (blocked) => void steps.push(`rule:${blocked}`),
      notify: vi.fn(async () => void steps.push("notify")),
    };
    return { set, steps };
  };

  it("does nothing, and writes nothing, while the stage stays", async () => {
    const { set, steps } = tools(quiet, "open");
    expect(await checkSpend(NOW, RENEWAL, set)).toBe("open");
    expect(steps).toEqual([]);
  });

  it("switches the rule before it says so, and only then tells", async () => {
    const { set, steps } = tools(costing(8), "no_uploads");
    expect(await checkSpend(NOW, RENEWAL, set)).toBe("blocked");
    expect(steps).toEqual(["rule:true", "stage:blocked", "notify"]);
  });

  it("gives back the days and lifts the rule when the line rises", async () => {
    const { set, steps } = tools(costing(6), "blocked");
    expect(await checkSpend(NOW, RENEWAL, set)).toBe("no_uploads");
    expect(steps).toEqual(["rule:false", "lift", "stage:no_uploads", "notify"]);
  });

  it("does not touch the rule between stages that are not blocked", async () => {
    const { set, steps } = tools(costing(6.5), "open");
    await checkSpend(NOW, RENEWAL, set);
    expect(steps).toEqual(["stage:no_uploads", "notify"]);
  });

  it("keeps the stage when the rule fails, so the next round tries again", async () => {
    const { set, steps } = tools(costing(8), "open");
    set.setBlocked = () => Promise.reject(new Error("no rule"));
    await expect(checkSpend(NOW, RENEWAL, set)).rejects.toThrow("no rule");
    expect(steps).toEqual([]);
  });

  it("keeps the stage when the usage cannot be read", async () => {
    const { set, steps } = tools(quiet, "blocked");
    set.usageSince = () => Promise.reject(new Error("no usage"));
    await expect(checkSpend(NOW, RENEWAL, set)).rejects.toThrow("no usage");
    expect(steps).toEqual([]);
  });

  it("asks for what was used since the cycle started", async () => {
    const { set } = tools(quiet, "open");
    const usageSince = vi.fn(async () => quiet);
    set.usageSince = usageSince;
    await checkSpend(NOW, RENEWAL, set);
    expect(usageSince).toHaveBeenCalledWith(Date.UTC(2026, 10, 15), NOW);
  });

  it("says the numbers, and nothing else", async () => {
    const { set } = tools(costing(8), "open");
    await checkSpend(NOW, RENEWAL, set);
    expect(set.notify).toHaveBeenCalledWith({ stage: "blocked", was: "open", bill: 8, line: 8 });
  });
});
