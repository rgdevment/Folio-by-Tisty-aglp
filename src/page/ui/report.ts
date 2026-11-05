import { levelOfReport } from "../../core/limits";
import { sealLink } from "./seal";
import { solved } from "./solve";

interface Sending {
  id: string;
  body: string;
}

const REFUSALS: Record<string, string> = {
  quota: "Tu red ya envió muchas denuncias en esta hora. Vuelve a intentarlo más tarde.",
  slow: "Hay demasiadas visitas desde tu red. Vuelve a intentarlo en un momento.",
};
const COULD_NOT_SEND = "No se pudo enviar la denuncia. Vuelve a intentarlo en un momento.";

const post = ({ id, body }: Sending, proof?: string): Promise<Response> =>
  fetch(`/api/v1/docs/${id}/report`, {
    method: "POST",
    credentials: "omit",
    headers: { "Content-Type": "application/json", ...(proof === undefined ? {} : { "Folio-Proof": proof }) },
    body,
  });

const refusalIn = async (response: Response): Promise<{ refused?: string; salt?: string; bits?: number }> =>
  response.json().catch(() => ({}));

// It says what went wrong, or null when the report arrived.
const sent = async (sending: Sending): Promise<string | null> => {
  const first = await post(sending);
  if (first.ok) return null;
  const { salt, bits, refused } = await refusalIn(first);
  const answer = salt !== undefined && bits !== undefined ? await post(sending, await solved(salt, bits)) : null;
  if (answer?.ok) return null;
  const finally_ = answer ? (await refusalIn(answer)).refused : refused;
  return REFUSALS[finally_ ?? ""] ?? COULD_NOT_SEND;
};

const part = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

export const offerReport = (id: string, linkKey: string, operatorKey: string): void => {
  const button = part<HTMLButtonElement>("report");
  const dialog = part<HTMLDialogElement>("report-dialog");
  const form = part<HTMLFormElement>("report-form");
  const consent = part<HTMLElement>("report-consent");
  const handOver = part<HTMLInputElement>("report-hand-over");
  const said = part<HTMLElement>("report-said");
  const submit = part<HTMLButtonElement>("report-send");

  const categoryOf = (): string => new FormData(form).get("category")?.toString() ?? "";
  const bodyOf = async (): Promise<string> => {
    const category = categoryOf();
    const detail = new FormData(form).get("detail")?.toString().trim() ?? "";
    const withLink = handOver.checked && levelOfReport(category) !== "light" && linkKey !== "";
    return JSON.stringify({
      category,
      ...(detail === "" ? {} : { detail }),
      ...(withLink ? { sealedLink: await sealLink(id, linkKey, operatorKey) } : {}),
    });
  };

  button.disabled = false;
  button.addEventListener("click", () => dialog.showModal());
  part<HTMLButtonElement>("report-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("change", () => {
    consent.hidden = levelOfReport(categoryOf()) === "light";
    if (consent.hidden) handOver.checked = false;
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    said.textContent = "Enviando…";
    const failed = await bodyOf()
      .then((body) => sent({ id, body }))
      .catch(() => COULD_NOT_SEND);
    said.textContent = failed ?? "Recibimos tu denuncia. Gracias.";
    submit.disabled = failed === null;
  });
};
