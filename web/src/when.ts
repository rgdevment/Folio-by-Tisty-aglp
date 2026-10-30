// The server counts in seconds since 1970; the reader reads a date in their own language.
export const day = (seconds: number, language: string, style: "long" | "medium" = "long"): string =>
  new Intl.DateTimeFormat(language, { dateStyle: style }).format(seconds * 1000);

const STEPS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ["year", 365 * 86_400],
  ["month", 30 * 86_400],
  ["week", 7 * 86_400],
  ["day", 86_400],
  ["hour", 3_600],
  ["minute", 60],
];

// The largest step that fits, so a change made yesterday reads as «yesterday» and never as 1,440 minutes.
export const ago = (seconds: number, now: number, language: string): string => {
  const past = Math.max(0, now - seconds);
  const [unit, size] = STEPS.find(([, size]) => past >= size) ?? ["minute", 60];
  return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(
    -Math.floor(past / size),
    unit,
  );
};
