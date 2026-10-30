// What a link names: the id the server keeps, and the key in the # that never leaves the browser.
export type Link = { readonly id: string; readonly key: string };

// Eight letters and digits, as the server mints them (tisty-share-server's keys.rs).
const ID = /^\/([0-9A-Za-z]{8})\/?$/;

// A path that names no document is no link; one without its # still is, with no key to open it.
export const linkOf = (path: string, hash: string): Link | null => {
  const id = ID.exec(path)?.[1];
  return id ? { id, key: hash.replace(/^#/, "") } : null;
};
