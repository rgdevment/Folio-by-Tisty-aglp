import type { Arrived } from "../read";

export interface NotArrived {
  refused: string;
}

// Loaded before anything else on the page, so the envelope is already coming while the reader's code is.
export const askFor = async (id: string): Promise<Arrived | NotArrived> => {
  try {
    const response = await fetch(`/api/v1/docs/${id}`, { credentials: "omit", cache: "no-store" });
    if (!response.ok) return { refused: ((await response.json()) as NotArrived).refused };
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      arrivedAt: Number(response.headers.get("Folio-Arrived")),
      diesOn: Number(response.headers.get("Folio-Dies-On")),
    };
  } catch {
    return { refused: "unreachable" };
  }
};
