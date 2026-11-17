/** Normalise BASE_PATH so Vite `base` always starts and ends with `/`. */
export function normaliseBasePath(value = '/'): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  return trimmed ? `/${trimmed}/` : '/';
}
