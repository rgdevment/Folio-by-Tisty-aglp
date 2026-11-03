import { describe, expect, it } from "vitest";
import { cleaned } from "../src/clean";

// As the browser itself writes it back, so only what cleaning took out tells the two apart.
const reread = (html: string): string => {
  const held = document.createElement("template");
  held.innerHTML = html;
  return held.innerHTML;
};

// One of everything the engine draws, as its snapshots show it.
const DRAWN = [
  '<h1 id="antes" data-at="0">Antes</h1>',
  '<p data-at="2">Uno <em>dos</em> <strong>tres</strong> <s>cuatro</s> <u>cinco</u> <ins>seis</ins> <kbd>Ctrl</kbd><sup class="fn">1</sup></p>',
  '<figure class="picture" data-at="4"><img src="tisty:picture/0" alt="La consola" loading="lazy"><figcaption>La consola</figcaption></figure>',
  '<table><colgroup><col style="width:80px"></colgroup><thead><tr><th scope="col" style="text-align:center" data-type="amount" data-currency="CLP">Monto</th></tr></thead><tbody><tr><td style="text-align:right" data-key="a" data-amiss="">10</td></tr></tbody><tfoot><tr><th data-total="">10</th></tr></tfoot></table>',
  '<blockquote data-callout="note" class="callout"><p>Ojo</p></blockquote>',
  '<p><span data-ico="check" data-hue="green" title="Listo"></span><mark data-pen="yellow">marcado</mark><span data-tag="docker" class="tag">#docker</span></p>',
  '<details open=""><summary>Más</summary><p>Dentro</p></details>',
  '<pre><code class="language-rust">fn main() {}</code></pre>',
  '<p><a href="tisty:doc/guia-2" data-doc="guia-2">Guía</a> <a href="https://tisty.app">Tisty</a> <a href="mailto:a@b.cl">correo</a> <a href="#antes">arriba</a></p>',
  '<math display="block"><mrow style="color:#ff0000;math-shift:compact;"><mi mathvariant="normal">x</mi><mo stretchy="false" lspace="0">=</mo><mfrac linethickness="0"><mn>1</mn><mn>2</mn></mfrac><mspace width="0.5em"></mspace><mtext style="font-size:1.2em"><span style="font-variant-caps: small-caps">ab</span></mtext></mrow></math>',
  '<ol start="3"><li data-at="9">tres</li></ol><dl><dt>Término</dt><dd>Qué es</dd></dl><hr>',
].join("");

describe("a drawn page, cleaned", () => {
  it("keeps everything Tisty draws as it was drawn", () => {
    expect(cleaned(DRAWN)).toBe(reread(DRAWN));
  });

  it("keeps a picture's size, so its room is kept before its bytes arrive", () => {
    const picture = '<img src="tisty:picture/0" alt="La consola" width="640" height="480">';
    expect(cleaned(picture)).toBe(reread(picture));
  });

  it("runs nothing the writer slipped in", () => {
    const page = cleaned(
      '<p>a</p><script>alert(1)</script><img src="tisty:picture/0" onerror="alert(1)"><a href="javascript:alert(1)">x</a><svg><script>alert(1)</script></svg>',
    );
    expect(page).not.toMatch(/script|onerror|javascript|svg/i);
    expect(page).toContain('<img src="tisty:picture/0">');
  });

  it("keeps an inline style only while every part of it is one Tisty writes", () => {
    const page = cleaned(
      '<table><tbody><tr><td style="text-align:center">a</td></tr></tbody></table><span style="color:#fff;position:fixed">b</span><span style="width:url(https://x.cl/a)">c</span>',
    );
    expect(page).toContain('style="text-align:center"');
    expect(page).not.toMatch(/position|url/);
  });

  it("lays nothing over the page and sends the reader nowhere unasked", () => {
    const page = cleaned(
      '<p style="position:fixed;inset:0">Escribe tu clave</p><td style="text-align:center;position:fixed">x</td><style>body{display:none}</style><meta http-equiv="refresh" content="0;url=https://x.cl"><base href="https://x.cl/"><iframe src="/"></iframe><form action="https://x.cl"><input name="clave"></form><link rel="stylesheet" href="https://x.cl/a.css">',
    );
    expect(page).not.toMatch(/style|meta|base|iframe|form|input|link/i);
    expect(page).toContain("Escribe tu clave");
  });

  it("leads only where Tisty leads: the web, an email, a document it cites or a place in the page", () => {
    const page = cleaned(
      '<a href="data:text/html,x">a</a><a href="ftp://x.cl">b</a><a href=" javascript:alert(1)">c</a><a href="tisty:doc/x">d</a>',
    );
    expect(page).toBe('<a>a</a><a>b</a><a>c</a><a href="tisty:doc/x">d</a>');
  });

  it("checks a whole inline value, within the sizes Tisty writes", () => {
    const page = cleaned(
      '<p style="width:1px:x(y)">a</p><p style="margin-left:-5000px">b</p><p style="font-size:9999px">c</p><p style="padding-left:-1em">d</p><math><mrow style="margin-left:-0.1667em"><mi>x</mi></mrow></math>',
    );
    expect(page).not.toMatch(/x\(y\)|5000|9999|-1em/);
    expect(page).toContain('style="margin-left:-0.1667em"');
  });

  it("keeps only the data the engine writes, and no aria of the writer's own", () => {
    const page = cleaned(
      '<span data-ico="star" data-evil="1" aria-live="assertive" aria-describedby="password">a</span>',
    );
    expect(page).toBe('<span data-ico="star">a</span>');
  });

  it("never leads to another site through a link that names no scheme", () => {
    const page = cleaned('<a href="//x.cl/a">a</a><a href="/\\x.cl">b</a><a href="#arriba">c</a>');
    expect(page).toBe('<a>a</a><a>b</a><a href="#arriba">c</a>');
  });

  it("asks no one outside the envelope for a picture", () => {
    const page = cleaned(
      '<img src="https://x.cl/t.png" alt="a"><img src="data:image/png;base64,AAAA" alt="b"><img src="tisty:picture/1" alt="c">',
    );
    expect(page).not.toMatch(/x\.cl|data:/);
    expect(page).toContain('<img src="tisty:picture/1" alt="c">');
  });
});
