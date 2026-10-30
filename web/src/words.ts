// The page speaks the reader's language when it is Spanish, and English otherwise, as Tisty does.
const SPANISH = {
  opening: "Abriendo el documento…",
  nolink:
    "Este link no lleva a un documento. Revisa que lo hayas copiado entero, con lo que va después del #.",
  missing: "Este documento no existe, o ya caducó.",
  gone: "Este documento ya no está disponible.",
  paused: "Quien lo compartió lo dejó en pausa.",
  blocked: "Este documento fue bloqueado tras varias denuncias.",
  password_asked:
    "Este documento pide una clave. Pronto podrás escribirla aquí; mientras, ábrelo en Tisty.",
  slow: "Se pidieron demasiadas lecturas desde tu red. Espera un momento y vuelve a intentarlo.",
  keyless:
    "A este link le falta su llave, lo que va después del #. Pide el link completo a quien te lo envió.",
  locked: "La llave de este link no abre el documento. Pide el link completo a quien te lo envió.",
  newer:
    "Este documento se escribió con una versión de Tisty más nueva que esta página. Ábrelo en Tisty.",
  offline: "No se pudo llegar a Tisty Share. Revisa tu conexión y vuelve a intentarlo.",
  down: "Tisty Share no responde en este momento. Vuelve a intentarlo en unos minutos.",
  failed: "No se pudo abrir este documento.",
  document: "Documento compartido",
  notices: "Licencias de terceros",
  saidnote: "Nota",
  saidtip: "Consejo",
  saidimportant: "Importante",
  saidwarning: "Aviso",
  saidcaution: "Cuidado",
} as const;

export type Word = keyof typeof SPANISH;

const ENGLISH: Record<Word, string> = {
  opening: "Opening the document…",
  nolink:
    "This link does not lead to a document. Check that you copied all of it, with what comes after the #.",
  missing: "This document does not exist, or it has expired.",
  gone: "This document is no longer available.",
  paused: "Whoever shared it has paused it.",
  blocked: "This document was blocked after several reports.",
  password_asked:
    "This document asks for a password. Soon you will type it here; meanwhile, open it in Tisty.",
  slow: "Too many reads came from your network. Wait a moment and try again.",
  keyless:
    "This link lacks its key, what comes after the #. Ask whoever sent it for the whole link.",
  locked: "This link's key does not open the document. Ask whoever sent it for the whole link.",
  newer: "This document was written by a newer Tisty than this page. Open it in Tisty.",
  offline: "Tisty Share could not be reached. Check your connection and try again.",
  down: "Tisty Share is not answering right now. Try again in a few minutes.",
  failed: "This document could not be opened.",
  document: "Shared document",
  notices: "Third-party licences",
  saidnote: "Note",
  saidtip: "Tip",
  saidimportant: "Important",
  saidwarning: "Warning",
  saidcaution: "Caution",
};

export const spanish = (language: string): boolean => language.toLowerCase().startsWith("es");

export const wordsFor = (inSpanish: boolean) => {
  const words: Record<Word, string> = inSpanish ? SPANISH : ENGLISH;
  return (word: string): string =>
    Object.hasOwn(words, word) ? words[word as Word] : words.failed;
};
