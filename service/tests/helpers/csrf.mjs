/**
 * Headers for a same-origin browser request: JSON body, CSRF token and the
 * session cookies returned by GET /auth/csrf.
 * @param {string} base API base URL, ending in /api/v1
 */
export async function getCsrfHeaders(base) {
  const csrf = await fetch(`${base}/auth/csrf`);
  const { token } = await csrf.json();
  return {
    "content-type": "application/json",
    "x-csrf-token": token,
    origin: base.replace("/api/v1", ""),
    cookie: csrf.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; "),
  };
}
