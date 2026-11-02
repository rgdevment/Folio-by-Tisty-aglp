import DOMPurify from "dompurify";

// The writer's own Tisty drew the page, so it is taken as anyone's: only what Tisty draws goes through (decision 91).
const purify = DOMPurify(window);

// What the engine writes, and what it lets through of the HTML written inside the Markdown.
const TAGS = [
  "a",
  "abbr",
  "acronym",
  "article",
  "aside",
  "b",
  "bdi",
  "bdo",
  "blockquote",
  "br",
  "caption",
  "center",
  "cite",
  "code",
  "col",
  "colgroup",
  "data",
  "dd",
  "del",
  "details",
  "dfn",
  "div",
  "dl",
  "dt",
  "em",
  "figcaption",
  "figure",
  "footer",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "i",
  "img",
  "ins",
  "kbd",
  "li",
  "mark",
  "nav",
  "ol",
  "p",
  "pre",
  "q",
  "rp",
  "rt",
  "rtc",
  "ruby",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "summary",
  "sup",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "time",
  "tr",
  "tt",
  "u",
  "ul",
  "var",
  "wbr",
  // The formulas math-core writes.
  "math",
  "menclose",
  "merror",
  "mfrac",
  "mi",
  "mmultiscripts",
  "mn",
  "mo",
  "mover",
  "mpadded",
  "mphantom",
  "mprescripts",
  "mroot",
  "mrow",
  "mspace",
  "msqrt",
  "msub",
  "msubsup",
  "msup",
  "mtable",
  "mtd",
  "mtext",
  "mtr",
  "munder",
  "munderover",
];

const ATTRIBUTES = [
  "alt",
  "class",
  "colspan",
  "datetime",
  "dir",
  "height",
  "href",
  "id",
  "lang",
  "loading",
  "open",
  "rowspan",
  "scope",
  "src",
  "start",
  "style",
  "title",
  "width",
  "accent",
  "accentunder",
  "depth",
  "display",
  "displaystyle",
  "form",
  "linethickness",
  "lspace",
  "mathvariant",
  "maxsize",
  "minsize",
  "movablelimits",
  "notation",
  "rspace",
  "scriptlevel",
  "stretchy",
  "symmetric",
  "voffset",
  // The data the engine writes for the sheet to read; any other is the writer's own and goes.
  "data-amiss",
  "data-as",
  "data-at",
  "data-callout",
  "data-currency",
  "data-doc",
  "data-done",
  "data-hue",
  "data-ico",
  "data-key",
  "data-pen",
  "data-ref",
  "data-tag",
  "data-task",
  "data-total",
  "data-type",
];

const LENGTH = /^(-?\d+(?:\.\d+)?)(px|em|rem|ex|%)$/;
const LONGEST: Record<string, number> = { px: 2000, em: 20, rem: 20, ex: 40, "%": 300 };

// As long as a sheet or a formula ever needs, and below zero only where a formula pulls a part back.
const length = (value: string, back = false): boolean => {
  const [, number, unit] = LENGTH.exec(value) ?? [];
  const size = Number(number);
  return unit !== undefined && (back || size >= 0) && Math.abs(size) <= (LONGEST[unit] ?? 0);
};

// Each property Tisty and its formulas write inline, with the values they write; none can lift a part off the page.
const STYLES: Record<string, (value: string) => boolean> = {
  color: (value) => /^#[\da-f]{3,8}$/i.test(value),
  "font-size": (value) => length(value),
  "font-variant-caps": (value) => value === "small-caps",
  "margin-left": (value) => length(value, true),
  "math-shift": (value) => value === "compact",
  "padding-left": (value) => length(value),
  "padding-right": (value) => length(value),
  "text-align": (value) => /^(?:left|center|right)$/.test(value),
  width: (value) => length(value),
};
const PICTURED = /^tisty:picture\/\d+$/;

const styled = (said: string): boolean =>
  said
    .split(";")
    .map((one) => one.trim())
    .filter(Boolean)
    .every((one) => {
      const at = one.indexOf(":");
      const property = one.slice(0, at).trim();
      return (
        at > 0 && Object.hasOwn(STYLES, property) && STYLES[property](one.slice(at + 1).trim())
      );
    });

// A picture is only ever one the envelope carries, so the page never asks anyone else for one.
purify.addHook("uponSanitizeAttribute", (_node, data) => {
  if (data.attrName === "style") data.keepAttr = styled(data.attrValue);
  if (data.attrName === "src") data.keepAttr = PICTURED.test(data.attrValue.trim());
});

export const cleaned = (html: string): string =>
  purify.sanitize(html, {
    ALLOWED_TAGS: TAGS,
    ALLOWED_ATTR: ATTRIBUTES,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
    // DOMPurify's own shape with the schemes cut to Tisty's; a value starting `//` would lead to another site.
    ALLOWED_URI_REGEXP:
      /^(?:(?:https?|mailto|tisty):|(?![\\/]{2})[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
  });
