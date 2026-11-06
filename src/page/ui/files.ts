import type { Attachment, Document } from "@tisty/contracts";
import { playableAs } from "@tisty/contracts/check";
import { type Bytes, fromBase64Url } from "../../core/bytes";
import { type EnvelopeRefusal, EnvelopeRefused } from "../../rules/envelope";
import { openFiles } from "../open";
import { NOT_ARRIVED, type NotArrived } from "./ask";
import { saysItIsAPage } from "./cards";
import { solved } from "./solve";

export interface FileAsking {
  id: string;
  linkKey: string;
  held: Document;
}

type Plays = NonNullable<ReturnType<typeof playableAs>>;

const SAVED_ADDRESS_LASTS_MS = 60_000;
const ASKING = "Trayendo el adjunto…";
const SAVED = "Se descargó. Presiona para guardarlo otra vez.";
const COULD_NOT_PLAY = "No se puede reproducir aquí. Presiona para guardarlo.";
const COULD_NOT_ARRIVE = "No se pudo traer el adjunto. Vuelve a intentarlo en un momento.";
const NOT_THERE = "El adjunto no está. Recarga la página para volver a intentarlo.";
const NOT_OPENED: Partial<Record<EnvelopeRefusal, string>> = {
  newer: "Este adjunto se escribió con una versión más nueva de la que esta página sabe leer.",
  damaged: "Este adjunto llegó dañado, así que no se guarda.",
  unsigned: "La firma de este adjunto no vale, así que no se guarda.",
};

class NotBrought extends Error {}

export const playerFor = (file: Attachment, bytes: Bytes): Plays | null =>
  saysItIsAPage(file) ? null : playableAs(bytes);

const asked = async (id: string, hash: string, proof?: string): Promise<Bytes | NotArrived> => {
  const response = await fetch(`/api/v1/docs/${id}/files/${hash}`, {
    credentials: "omit",
    cache: "no-store",
    ...(proof === undefined ? {} : { headers: { "Folio-Proof": proof } }),
  });
  return response.ok ? new Uint8Array(await response.arrayBuffer()) : ((await response.json()) as NotArrived);
};

const bytesOfFiles = async ({ id, linkKey, held }: FileAsking): Promise<Bytes[]> => {
  const hash = held.files_hash as string;
  const first = await asked(id, hash);
  const answer =
    "refused" in first && first.salt !== undefined && first.bits !== undefined
      ? await asked(id, hash, await solved(first.salt, first.bits))
      : first;
  if ("refused" in answer) {
    throw new NotBrought(answer.refused === "missing" ? NOT_THERE : (NOT_ARRIVED[answer.refused] ?? COULD_NOT_ARRIVE));
  }
  const open = await openFiles(held, answer, { id, kind: "files" }, linkKey ? fromBase64Url(linkKey) : undefined);
  return open.opened;
};

const whyNot = (error: unknown): string => {
  if (error instanceof NotBrought) return error.message;
  if (error instanceof EnvelopeRefused) return NOT_OPENED[error.refusal] ?? COULD_NOT_ARRIVE;
  return COULD_NOT_ARRIVE;
};

const told = (link: HTMLElement, said: string): void => {
  link.setAttribute("title", said);
  const blurb = link.querySelector(".card-blurb");
  if (blurb) {
    blurb.textContent = said;
    return;
  }
  const next = link.nextElementSibling;
  const note = next?.classList.contains("file-said") ? next : link.ownerDocument.createElement("span");
  note.className = "file-said";
  note.textContent = said;
  link.after(note);
};

const saved = ({ name }: Attachment, bytes: Bytes): void => {
  const address = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const saving = document.createElement("a");
  saving.href = address;
  saving.download = name;
  saving.click();
  setTimeout(() => URL.revokeObjectURL(address), SAVED_ADDRESS_LASTS_MS);
};

const played = (link: HTMLElement, file: Attachment, bytes: Bytes, plays: Plays, onFailure: () => void): boolean => {
  const player = link.ownerDocument.createElement(plays.player);
  if (player.canPlayType(plays.type) === "") return false;
  player.className = "file-player";
  player.controls = true;
  player.preload = "metadata";
  player.setAttribute("aria-label", file.name);
  const address = URL.createObjectURL(new Blob([bytes], { type: plays.type }));
  player.addEventListener(
    "error",
    () => {
      URL.revokeObjectURL(address);
      player.replaceWith(link);
      onFailure();
    },
    { once: true },
  );
  player.src = address;
  link.replaceWith(player);
  return true;
};

export const filePresser = (asking: FileAsking) => {
  let opening: Promise<Bytes[]> | undefined;
  const opened = (): Promise<Bytes[]> => {
    opening ??= bytesOfFiles(asking).catch((error: unknown) => {
      opening = undefined;
      throw error;
    });
    return opening;
  };
  const couldNotPlay = new Set<number>();

  return async (link: HTMLElement): Promise<void> => {
    const file = asking.held.files?.find((one) => one.at === Number(link.getAttribute("data-file")));
    if (!file || link.getAttribute("aria-busy") === "true") return;
    link.setAttribute("aria-busy", "true");
    told(link, ASKING);
    try {
      const bytes = (await opened())[file.at] as Bytes;
      const plays = playerFor(file, bytes);
      const standsAlone = link.classList.contains("doc-card");
      const canPlay = plays && standsAlone && !couldNotPlay.has(file.at);
      const fail = () => {
        couldNotPlay.add(file.at);
        told(link, COULD_NOT_PLAY);
      };
      if (canPlay && played(link, file, bytes, plays, fail)) return;
      saved(file, bytes);
      told(link, SAVED);
    } catch (error) {
      told(link, whyNot(error));
    } finally {
      link.removeAttribute("aria-busy");
    }
  };
};
