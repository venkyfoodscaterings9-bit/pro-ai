export function normalizeBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("Enter a valid provider base URL.");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("The provider base URL must use HTTP or HTTPS and must not contain credentials.");
  }
  if (url.search || url.hash) throw new Error("The provider base URL must not include a query string or fragment.");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/(?:\/v1){2,}$/i, "/v1");
  return url.toString().replace(/\/+$/, "");
}

export function getProviderEndpoint(baseUrl: string, endpoint: string): string {
  const base = normalizeBaseUrl(baseUrl);
  const suffix = endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
  const baseHasV1 = /\/v1$/i.test(new URL(base).pathname);
  const normalizedSuffix = baseHasV1 ? suffix.replace(/^\/v1(?=\/|$)/i, "") : suffix;
  return `${base}${normalizedSuffix}`;
}
