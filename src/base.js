/**
 * Resolve a public/ asset path against Vite's base URL.
 * Required for GitHub Pages project deploys (not served from domain root).
 */
export function publicUrl(path) {
  const base = import.meta.env.BASE_URL || './'
  const clean = String(path).replace(/^\//, '')
  return base.endsWith('/') ? `${base}${clean}` : `${base}/${clean}`
}
