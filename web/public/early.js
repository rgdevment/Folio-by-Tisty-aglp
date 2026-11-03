// Asked for before the page's code arrives, so the envelope travels while the code does; the code takes it once.
(() => {
  const id = /^\/([0-9A-Za-z]{8})\/?$/.exec(location.pathname)?.[1];
  if (!id || location.hash.length < 2 || "tistyEarly" in globalThis) return;
  const answer = fetch(`/api/v1/docs/${id}`);
  // The page says why a read failed; until it takes this one, a failure here is nobody's to report.
  answer.catch(() => undefined);
  globalThis.tistyEarly = { id, answer };
})();
