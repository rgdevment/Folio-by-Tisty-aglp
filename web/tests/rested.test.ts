import { describe, expect, it } from "vitest";
import type { Refusal } from "../src/fetched";
import { type Clock, type Held, LASTS, resting, WAITS } from "../src/rested";

const bytes = new Uint8Array([1, 2, 3]);

const sheetOf = (fails?: Error) => {
  const freed: string[] = [];
  const sheet: Held = {
    rest: () => {
      if (fails) throw fails;
      return {
        pictures: 2,
        picture: (at) => new Uint8Array([at]),
        text: "# Hola",
        free: () => freed.push("rest"),
      };
    },
    free: () => freed.push("sheet"),
  };
  return { sheet, freed };
};

const clockOf = () => {
  const waited: number[] = [];
  let lapse: (() => void) | undefined;
  let cancelled = false;
  const time: Clock = {
    wait: async (ms) => {
      waited.push(ms);
    },
    later: (done, ms) => {
      expect(ms).toBe(LASTS);
      lapse = done;
      return () => {
        cancelled = true;
      };
    },
  };
  return { time, waited, lapse: () => lapse?.(), cancelled: () => cancelled };
};

const answers = (...said: (Uint8Array | Refusal)[]) => {
  const asked: number[] = [];
  const ask = async () => {
    asked.push(asked.length);
    return said[Math.min(asked.length - 1, said.length - 1)];
  };
  return { ask, asked };
};

describe("the rest of a sheet", () => {
  it("brings the pictures with their media and the text, and lets go of the sheet once", async () => {
    const { sheet, freed } = sheetOf();
    const clock = clockOf();
    const { ask, asked } = answers(bytes);
    const rest = resting(sheet, ["image/png", "image/webp"], ask, clock.time);
    const arrived = await rest();
    expect(arrived).toEqual({
      pictures: [
        { bytes: new Uint8Array([0]), media: "image/png" },
        { bytes: new Uint8Array([1]), media: "image/webp" },
      ],
      text: "# Hola",
    });
    expect(await rest()).toBe(arrived);
    expect(asked).toHaveLength(1);
    expect(freed).toEqual(["rest", "sheet"]);
    expect(clock.cancelled()).toBe(true);
  });

  it("is asked again after a dropped connection, waiting longer each time", async () => {
    const { sheet, freed } = sheetOf();
    const clock = clockOf();
    const { ask, asked } = answers({ refused: "offline" }, { refused: "down" }, bytes);
    const arrived = await resting(sheet, [], ask, clock.time)();
    expect(typeof arrived).toBe("object");
    expect(asked).toHaveLength(3);
    expect(clock.waited).toEqual(WAITS);
    expect(freed).toEqual(["rest", "sheet"]);
  });

  it("gives up after its last wait, and on any other refusal at once", async () => {
    const dropped = sheetOf();
    const offline = answers({ refused: "offline" });
    expect(await resting(dropped.sheet, [], offline.ask, clockOf().time)()).toBe("offline");
    expect(offline.asked).toHaveLength(WAITS.length);
    expect(dropped.freed).toEqual(["sheet"]);

    const replaced = sheetOf();
    const missing = answers({ refused: "missing" });
    expect(await resting(replaced.sheet, [], missing.ask, clockOf().time)()).toBe("missing");
    expect(missing.asked).toHaveLength(1);
    expect(replaced.freed).toEqual(["sheet"]);
  });

  it("that does not hold says why in one word and still lets go of the sheet", async () => {
    const { sheet, freed } = sheetOf(new Error("damaged"));
    const { ask } = answers(bytes);
    expect(await resting(sheet, [], ask, clockOf().time)()).toBe("damaged");
    expect(freed).toEqual(["sheet"]);
  });

  it("never asked before its ticket runs out lets go of the sheet and asks nothing", async () => {
    const { sheet, freed } = sheetOf();
    const clock = clockOf();
    const { ask, asked } = answers(bytes);
    const rest = resting(sheet, [], ask, clock.time);
    clock.lapse();
    expect(freed).toEqual(["sheet"]);
    expect(await rest()).toBe("forbidden");
    expect(asked).toHaveLength(0);
    expect(freed).toEqual(["sheet"]);
  });

  it("asked before its ticket runs out is not let go of twice when the time comes", async () => {
    const { sheet, freed } = sheetOf();
    const clock = clockOf();
    const rest = resting(sheet, [], answers(bytes).ask, clock.time);
    await rest();
    clock.lapse();
    expect(freed).toEqual(["rest", "sheet"]);
  });
});
