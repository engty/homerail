export function isTrustedLocalAppUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:'
      && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost')
  } catch {
    return false
  }
}

export function isAllowedMediaPermission(permission: string, requestingUrl: string): boolean {
  return permission === 'media' && isTrustedLocalAppUrl(requestingUrl)
}
