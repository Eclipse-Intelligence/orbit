const SAFE_SCHEMES = new Set(["http:", "https:", "mailto:"]);

export function safeHref(raw: string) {
  const value = raw.trim().replace(/^<|>$/g, "");
  if (!value) return null;
  if (/^\/(?![/\\])/.test(value)) return value;
  const candidate = /^www\./i.test(value) ? `https://${value}` : value;
  if (!/^[a-z][a-z\d+.-]*:/i.test(candidate)) return /^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(candidate) ? `mailto:${candidate}` : null;
  try {
    const url = new URL(candidate);
    return SAFE_SCHEMES.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}
