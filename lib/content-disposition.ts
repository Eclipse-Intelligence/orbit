export function contentDisposition(kind: "inline" | "attachment", name: string) {
  const clean = name.replace(/[\r\n"]/g, "_").trim() || "attachment";
  const fallback = clean.replace(/[^\x20-\x7e]|\\/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export function wantsDownload(params: URLSearchParams) {
  return params.get("download") === "1";
}
