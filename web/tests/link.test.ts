import { describe, expect, it } from "vitest";
import { linkOf, readLinkOf } from "../src/link";

describe("a link", () => {
  it("names the document by its path and keeps the key the # carries", () => {
    expect(linkOf("/k7Qm2xPa", "#qR12Ff")).toEqual({ id: "k7Qm2xPa", key: "qR12Ff" });
    expect(linkOf("/k7Qm2xPa/", "#qR12Ff")).toEqual({ id: "k7Qm2xPa", key: "qR12Ff" });
  });

  it("drops only the # that opens it, never one inside the key", () => {
    expect(linkOf("/k7Qm2xPa", "ab#cd")?.key).toBe("ab#cd");
  });

  it("reads an edit link with the key before its dot, and never hands the token on", () => {
    expect(linkOf("/k7Qm2xPa", "#qR12Ff.Zp4u9TqLw2")).toEqual({ id: "k7Qm2xPa", key: "qR12Ff" });
  });

  it("is passed on as the link to read, whatever token the opened one carried", () => {
    const link = linkOf("/k7Qm2xPa", "#qR12Ff.Zp4u9TqLw2");
    expect(link && readLinkOf("https://tisty.cl", link)).toBe("https://tisty.cl/k7Qm2xPa#qR12Ff");
  });

  it("without its # still names the document, with no key to open it", () => {
    expect(linkOf("/k7Qm2xPa", "")).toEqual({ id: "k7Qm2xPa", key: "" });
  });

  it("is no link when the path names no document", () => {
    for (const path of [
      "/",
      "/k7Qm2xP",
      "/k7Qm2xPa9",
      "/api/v1/limits",
      "/k7Qm-xPa",
      "/a/k7Qm2xPa",
    ])
      expect(linkOf(path, "#qR12Ff"), path).toBeNull();
  });
});
