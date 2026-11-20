/**
 * App-update helpers.
 *
 * A published update stores either
 *   - a full http(s) URL (used as-is), or
 *   - a file name inside the private B2 bucket, e.g. "updates/system-manager-v23.apk".
 * The second form is preferred: the APK stays private and every /update/version.json
 * request gets a fresh short-lived download link, so the link never goes stale.
 */
export const isAbsoluteUrl = (value) => /^https?:\/\//i.test(String(value ?? ""));

export async function resolveDownloadUrl(stored, signFileName) {
  if (!stored) return "";
  return isAbsoluteUrl(stored) ? stored : signFileName(stored);
}

export const SHA256_HEX = /^[a-f0-9]{64}$/i;

/** Validates the body of a publish-update request. Returns { error } or { value }. */
export function validatePublishBody({ versionCode, downloadUrl, sha256 }) {
  const code = Number(versionCode);
  if (!Number.isInteger(code) || code < 1 || code > 2_000_000_000) {
    return { error: "versionCode must be a positive integer" };
  }
  if (typeof downloadUrl !== "string" || downloadUrl.length < 3 || downloadUrl.length > 500) {
    return { error: "downloadUrl must be a URL or a B2 file name" };
  }
  if (!isAbsoluteUrl(downloadUrl) && (downloadUrl.startsWith("/") || downloadUrl.includes(".."))) {
    return { error: "B2 file name must be a relative path without .." };
  }
  if (sha256 != null && sha256 !== "" && !SHA256_HEX.test(String(sha256))) {
    return { error: "sha256 must be 64 hex characters" };
  }
  return { value: { versionCode: code, downloadUrl, sha256: sha256 ? String(sha256).toLowerCase() : undefined } };
}
