import type { Arrived } from "../read";

export interface NotArrived {
  refused: string;
  salt?: string;
  bits?: number;
}

// Loaded before anything else on the page, so the envelope is already coming while the reader's code is.
export const askFor = async (id: string, proof?: string): Promise<Arrived | NotArrived> => {
  try {
    const response = await fetch(`/api/v1/docs/${id}`, {
      credentials: "omit",
      cache: "no-store",
      ...(proof === undefined ? {} : { headers: { "Folio-Proof": proof } }),
    });
    if (!response.ok) return (await response.json()) as NotArrived;
    const arrivedAt = Number(response.headers.get("Folio-Arrived"));
    const diesOn = Number(response.headers.get("Folio-Dies-On"));
    // Without its dates a signature would be weighed against 1970, so it is not taken as an answer.
    if (!(arrivedAt > 0 && diesOn > 0)) return { refused: "unreachable" };
    return { bytes: new Uint8Array(await response.arrayBuffer()), arrivedAt, diesOn };
  } catch {
    return { refused: "unreachable" };
  }
};
