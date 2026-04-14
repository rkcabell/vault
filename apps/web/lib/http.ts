/** Reads a plain-text error message from a failed Response, falling back to a status phrase. */
export async function readErrorFromResponse(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  return text || httpStatusMessage(res.status);
}

/** Converts an HTTP status code to a short, user-readable phrase. */
export function httpStatusMessage(status: number): string {
  if (status === 400) return 'Invalid request';
  if (status === 401) return 'Session expired — please sign in again';
  if (status === 403) return 'Access denied';
  if (status === 404) return 'Not found';
  if (status === 409) return 'Already exists';
  if (status === 413) return 'File too large';
  if (status === 429) return 'Too many requests — please slow down';
  if (status >= 500) return 'Server error — please try again';
  return `Unexpected error (${status})`;
}
