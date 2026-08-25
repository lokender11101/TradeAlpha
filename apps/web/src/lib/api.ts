function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  if (match) return decodeURIComponent(match[2]);
  return null;
}

export async function apiFetch(endpoint: string, options: RequestInit = {}): Promise<Response> {
  const baseUrl = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:3000/api';
  const url = `${baseUrl}${endpoint}`;

  const headers = new Headers(options.headers);
  headers.set('Content-Type', 'application/json');

  const csrfToken = getCookie('csrf_token');
  if (csrfToken && options.method && ['POST', 'PUT', 'DELETE', 'PATCH'].includes(options.method.toUpperCase())) {
    headers.set('x-csrf-token', csrfToken);
  }

  // Include credentials so that HttpOnly cookie and CSRF token cookie are sent and received
  const fetchOptions: RequestInit = {
    ...options,
    headers,
    cache: options.cache || 'no-store',
    credentials: 'true' === process.env.NEXT_PUBLIC_DISABLE_CREDENTIALS ? 'same-origin' : 'include',
  };

  return fetch(url, fetchOptions);
}
