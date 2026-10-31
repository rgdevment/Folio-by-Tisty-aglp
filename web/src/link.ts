// What a link names: the id the server keeps, and the key in the # that never leaves the browser.
export type Link = { readonly id: string; readonly key: string };

// Eight letters and digits, as the server mints them (tisty-share-server's keys.rs).
const ID = /^\/([0-9A-Za-z]{8})\/?$/;

// What a reader may pass on: the link to read, never an edit token the address they opened carried.
export const readLinkOf = (origin: string, link: Link): string =>
  `${origin}/${link.id}#${link.key}`;

// A path that names no document is no link; one without its # still is, with no key to open it.
// An edit link carries its token after a dot (decision 66): the page only reads, so it leaves the token alone.
export const linkOf = (path: string, hash: string): Link | null => {
  const id = ID.exec(path)?.[1];
  return id ? { id, key: hash.replace(/^#/, "").split(".")[0] } : null;
};
