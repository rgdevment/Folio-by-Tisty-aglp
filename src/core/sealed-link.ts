export const SEALED_LINK_PREFIX = "sealed1.";

const SEALED = /^sealed1\.[A-Za-z0-9_-]{150,}$/;

export const isSealedLink = (said: string): boolean => SEALED.test(said);
