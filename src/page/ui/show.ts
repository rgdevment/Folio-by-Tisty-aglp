import { type EnvelopeRefusal, EnvelopeRefused } from "../../rules/envelope";
import { OPERATOR_KEY } from "../operator-key";
import type { Arrived } from "../read";
import { openLink } from "../read";
import { askFor, type NotArrived } from "./ask";
import { domPurifyCleaner } from "./clean";
import { drawClosed } from "./closed";
import { finished, pictureAddresses } from "./finish";
import { drawFrame } from "./frame";
import { offerReport } from "./report";
import { solved } from "./solve";

const DAY_MILLISECONDS = 86_400_000;

const NOT_ARRIVED: Record<string, string> = {
  paused: "Quien compartió este documento lo pausó.",
  blocked: "Este documento fue bloqueado.",
  slow: "Hay demasiadas visitas desde tu red. Vuelve a intentarlo en un momento.",
  quota: "Hay demasiadas visitas desde tu red. Vuelve a intentarlo más tarde.",
  proof: "Este documento tuvo muchas visitas hoy. Vuelve a intentarlo más tarde.",
};
const COULD_NOT_ARRIVE = "No se pudo traer el documento. Vuelve a intentarlo en un momento.";

const REFUSED: Record<EnvelopeRefusal, string> = {
  newer:
    "Este documento se escribió con una versión más nueva de la que esta página sabe leer. Vuelve a intentarlo más tarde.",
  older: "Este documento es demasiado antiguo para esta página.",
  damaged: "Este documento llegó dañado, así que no se muestra.",
  unsigned: "La firma de este documento no vale, así que no se muestra.",
  key: "Este link no abre el documento. Pídele el link completo a quien te lo mandó.",
};

const lastDay = (diesOn: number): string =>
  new Date(diesOn * DAY_MILLISECONDS).toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });

const shown = async (id: string, linkKey: string, arrived: Arrived): Promise<void> => {
  const { held, pictures, verdict, fingerprint, ownerFingerprint, diesOn } = await openLink(id, linkKey, arrived);
  const cleaner = domPurifyCleaner(window);
  const addresses = pictureAddresses(held.pictures ?? [], pictures);
  drawFrame(held, (html) => finished(cleaner.clean(html), addresses), {
    verdict,
    fingerprint,
    ownerFingerprint,
    diesOn: lastDay(diesOn),
  });
  offerReport(id, linkKey, OPERATOR_KEY);
};

export const showLink = async (
  id: string,
  linkKey: string,
  asked: Promise<Arrived | NotArrived>,
  notFound: string,
): Promise<void> => {
  const first = await asked;
  // Past a document's free readers of the day, the server asks for a little work and not for a wait.
  const answer =
    "refused" in first && first.salt !== undefined && first.bits !== undefined
      ? await askFor(id, await solved(first.salt, first.bits))
      : first;
  if ("refused" in answer) {
    if (answer.refused === "missing") location.replace(notFound);
    else drawClosed(NOT_ARRIVED[answer.refused] ?? COULD_NOT_ARRIVE);
    return;
  }
  try {
    await shown(id, linkKey, answer);
  } catch (error) {
    if (!(error instanceof EnvelopeRefused)) throw error;
    drawClosed(REFUSED[error.refusal]);
  }
};
