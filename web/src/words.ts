// The page speaks the reader's language when it is Spanish, and English otherwise, as Tisty does.
const SPANISH = {
  opening: "Abriendo el documento…",
  nolink:
    "Este link no lleva a un documento. Revisa que lo hayas copiado entero, con lo que va después del #.",
  unwritten: "Este documento todavía se está subiendo. Vuelve a intentarlo en un momento.",
  paused: "Quien lo compartió lo dejó en pausa.",
  blocked: "Este documento fue bloqueado tras varias denuncias.",
  password_asked: "Este documento pide una clave.",
  password_wrong: "La clave no es correcta.",
  password_locked: "Demasiados intentos con la clave. Vuelve a intentarlo en unos minutos.",
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
  gatelabel: "Clave",
  gateopen: "Abrir",
  shared: "Compartido el {}",
  written: "editado {}",
  signedby: "Firmado por",
  sentby: "Subido por",
  holds: "Firma válida",
  revoked: "La llave que lo firmó fue revocada: no se puede saber si lo firmó su dueño",
  refused: "La firma no corresponde a este documento",
  unreadable: "La firma no se pudo leer",
  unsigned: "Sin firma: no se puede saber quién lo escribió",
  openin: "Abrir en Tisty",
  gettisty: "Descargar Tisty",
  matches: "La firma coincide con esta llave",
  download: "Descargar el Markdown",
  copy: "Copiar link",
  copied: "Link copiado",
  access: "Acceso",
  unlisted: "Solo con el link",
  gated: "Con el link y una clave",
  ends: "Caduca",
  endsnote: "Cada lectura aleja esta fecha.",
  report: "Denunciar este documento",
  reportwhy: "Motivo",
  reportpick: "Elige un motivo",
  reportdetail: "Cuéntanos qué pasa",
  reportsend: "Enviar denuncia",
  reportcancel: "Cancelar",
  reporting: "Enviando la denuncia…",
  thanked: "Gracias. Recibimos tu denuncia.",
  reported: "Ya denunciaste este documento.",
  report_child_abuse: "Abuso sexual infantil",
  report_explicit: "Imágenes sexuales explícitas",
  report_intimate: "Imágenes íntimas sin consentimiento",
  report_phishing: "Phishing o robo de cuentas",
  report_malware: "Malware",
  report_fraud: "Estafa",
  report_threat: "Amenazas o incitación a un delito",
  report_doxxing: "Datos personales de alguien expuestos",
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
  unwritten: "This document is still being uploaded. Try again in a moment.",
  paused: "Whoever shared it has paused it.",
  blocked: "This document was blocked after several reports.",
  password_asked: "This document asks for a password.",
  password_wrong: "That password is not the right one.",
  password_locked: "Too many tries with the password. Try again in a few minutes.",
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
  gatelabel: "Password",
  gateopen: "Open",
  shared: "Shared on {}",
  written: "edited {}",
  signedby: "Signed by",
  sentby: "Uploaded by",
  holds: "Valid signature",
  revoked: "The key that signed it was revoked: it cannot be told whether its owner signed it",
  refused: "The signature does not match this document",
  unreadable: "The signature could not be read",
  unsigned: "Not signed: there is no telling who wrote it",
  openin: "Open in Tisty",
  gettisty: "Get Tisty",
  matches: "The signature matches this key",
  download: "Download the Markdown",
  copy: "Copy link",
  copied: "Link copied",
  access: "Access",
  unlisted: "Anyone with the link",
  gated: "Anyone with the link and a password",
  ends: "Expires",
  endsnote: "Every reading pushes this date back.",
  report: "Report this document",
  reportwhy: "Reason",
  reportpick: "Choose a reason",
  reportdetail: "Tell us what is wrong",
  reportsend: "Send report",
  reportcancel: "Cancel",
  reporting: "Sending the report…",
  thanked: "Thank you. Your report reached us.",
  reported: "You already reported this document.",
  report_child_abuse: "Child sexual abuse",
  report_explicit: "Explicit sexual images",
  report_intimate: "Intimate images shared without consent",
  report_phishing: "Phishing or account theft",
  report_malware: "Malware",
  report_fraud: "Fraud",
  report_threat: "Threats or incitement to a crime",
  report_doxxing: "Someone's personal details exposed",
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

// The Worker sends it on to tisty.app, which already answers a missing page in the reader's language.
export const NOWHERE = "/404";

const LOST = new Set(["missing", "gone"]);

// A document the server no longer has goes where any missing page goes; every other refusal is said here.
export const refused = (word: string, leave: (to: string) => void, tell: (word: string) => void) =>
  LOST.has(word) ? leave(NOWHERE) : tell(word);

// A refusal the reader answers by saying the password, rather than one that ends the reading.
const GATED = new Set(["password_asked", "password_wrong", "password_locked"]);

export const gated = (word: string): boolean => GATED.has(word);

// Fills a sentence that names a date or a time, so each language keeps its own order around it.
export const filled = (sentence: string, said: string): string => sentence.replace("{}", said);
