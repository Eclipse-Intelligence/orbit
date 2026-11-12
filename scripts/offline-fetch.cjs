const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const realFetch = globalThis.fetch;

function hostOf(input) {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input?.url;
  try {
    return new URL(href).hostname;
  } catch {
    return "";
  }
}

globalThis.fetch = (input, init) => {
  const host = hostOf(input);
  if (host && !LOCAL_HOSTS.has(host)) {
    console.error(`offline-fetch blocked a request to ${host}`);
    return Promise.reject(new Error(`Blocked a request to ${host}: this server runs offline.`));
  }
  return realFetch(input, init);
};
