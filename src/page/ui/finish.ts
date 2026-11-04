import type { Picture } from "@tisty/contracts";
import type { Bytes } from "../../core/bytes";
import { pictureHolds } from "../open";

const PICTURE = /^tisty:picture\/(\d+)$/;
const LEAVES = /^(https?|mailto):/i;

// One that does not hold has no address: it shows its alt, and the words still read.
export const pictureAddresses = (said: Picture[], bytes: Bytes[]): (string | null)[] =>
  said.map((picture, at) => {
    const held = bytes[at];
    if (!held || !pictureHolds(held, picture)) return null;
    return URL.createObjectURL(new Blob([held], { type: picture.kind }));
  });

export const bareUrl = (said: string): string => [...said].filter((one) => one > " ").join("");

export const finished = (words: DocumentFragment, addresses: (string | null)[]): DocumentFragment => {
  for (const image of words.querySelectorAll("img")) {
    const at = PICTURE.exec(bareUrl(image.getAttribute("src") ?? ""))?.[1];
    const address = at === undefined ? null : addresses[Number(at)];
    if (address) image.setAttribute("src", address);
    else image.removeAttribute("src");
  }
  for (const link of words.querySelectorAll("a[href]")) {
    if (LEAVES.test(bareUrl(link.getAttribute("href") ?? ""))) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }
  return words;
};
