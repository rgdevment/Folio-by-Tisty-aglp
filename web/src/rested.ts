import type { Picture } from "./drawn";
import type { Refusal } from "./fetched";

export type Arrived = { readonly pictures: readonly Picture[]; readonly text: string };

type Opened = {
  readonly pictures: number;
  picture(at: number): Uint8Array | undefined;
  readonly text: string;
  free(): void;
};

export type Held = {
  rest(bytes: Uint8Array): Opened;
  free(): void;
};

export type Clock = {
  readonly wait: (ms: number) => Promise<void>;
  readonly later: (done: () => void, ms: number) => () => void;
};

export const WAITS = [0, 2000, 6000];
export const LASTS = 9 * 60 * 1000;
const PASSING = new Set(["offline", "down"]);
export const STALE = new Set(["forbidden", "missing"]);

const clock: Clock = {
  wait: (ms) => new Promise((done) => setTimeout(done, ms)),
  later: (done, ms) => {
    const timer = setTimeout(done, ms);
    return () => clearTimeout(timer);
  },
};

const wordOf = (refused: unknown): string =>
  refused instanceof Error ? refused.message : "failed";

export const picturesOf = (
  count: number,
  bytes: (at: number) => Uint8Array | undefined,
  media: (at: number) => string | undefined,
): Picture[] =>
  Array.from({ length: count }, (_, at) => ({
    // wasm-bindgen hands each picture over in a buffer of its own, never a shared one.
    bytes: (bytes(at) ?? new Uint8Array()) as Uint8Array<ArrayBuffer>,
    media: media(at) ?? "",
  }));

const arrivedFor = async (
  sheet: Held,
  media: readonly string[],
  ask: () => Promise<Uint8Array | Refusal>,
): Promise<Arrived | string> => {
  try {
    const answer = await ask();
    if ("refused" in answer) return answer.refused;
    const rest = sheet.rest(answer);
    try {
      const pictures = picturesOf(
        rest.pictures,
        (at) => rest.picture(at),
        (at) => media[at],
      );
      return { pictures, text: rest.text };
    } finally {
      rest.free();
    }
  } catch (error_) {
    return wordOf(error_);
  }
};

const tried = async (
  sheet: Held,
  media: readonly string[],
  ask: () => Promise<Uint8Array | Refusal>,
  wait: Clock["wait"],
): Promise<Arrived | string> => {
  let arrived: Arrived | string = "failed";
  try {
    for (const ms of WAITS) {
      await wait(ms);
      arrived = await arrivedFor(sheet, media, ask);
      if (typeof arrived !== "string" || !PASSING.has(arrived)) return arrived;
    }
    return arrived;
  } finally {
    sheet.free();
  }
};

export const resting = (
  sheet: Held,
  media: readonly string[],
  ask: () => Promise<Uint8Array | Refusal>,
  time: Clock = clock,
): (() => Promise<Arrived | string>) => {
  let arriving: Promise<Arrived | string> | undefined;
  const lapse = time.later(() => {
    if (arriving) return;
    arriving = Promise.resolve("forbidden");
    sheet.free();
  }, LASTS);
  return () => {
    if (!arriving) {
      lapse();
      arriving = tried(sheet, media, ask, time.wait);
    }
    return arriving;
  };
};
