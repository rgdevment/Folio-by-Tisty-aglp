import { macOf } from "./start";

const IPV6_GROUPS = 8;
const GROUPS_IN_A_NET = 3;

// A whole IPv4, or the /48 of an IPv6, since one home holds many addresses of a /48 (decision 128).
export const netOf = (ip: string): string => {
  if (!ip.includes(":")) return ip;
  const [head = "", tail] = ip.toLowerCase().split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const zeros = ip.includes("::") ? IPV6_GROUPS - front.length - back.length : 0;
  const groups = [...front, ...Array.from({ length: zeros }, () => "0"), ...back];
  return groups
    .slice(0, GROUPS_IN_A_NET)
    .map((one) => one.padStart(4, "0"))
    .join(":");
};

export const netDigest = (dayKey: string, ip: string): Promise<string> => macOf(dayKey, `net|${netOf(ip)}`);

// Kept for the day in the isolate, or each read would pay one more R2 read for a key that changes once a day.
export class DayKeys {
  #day = -1;
  #key = "";

  async of(today: number, fetchKey: (today: number) => Promise<string>): Promise<string> {
    if (this.#day !== today) {
      this.#key = await fetchKey(today);
      this.#day = today;
    }
    return this.#key;
  }
}
