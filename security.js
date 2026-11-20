import crypto from "crypto";

/**
 * Constant-time string comparison. Hashing both sides first means the comparison
 * time doesn't depend on the contents or length of either value.
 */
export function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(String(a ?? "")).digest();
  const hb = crypto.createHash("sha256").update(String(b ?? "")).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Reachable without the API key: the platform health probe and the landing text.
// /api/admin/* has its own ADMIN_SECRET check, so it is not gated by the app's API key.
const OPEN_PATHS = new Set(["/", "/health"]);
const isOpenPath = (rawPath) => {
  const path = rawPath.replace(/\/+$/, "") || "/"; // "/health/" == "/health"
  return OPEN_PATHS.has(path) || path.startsWith("/api/admin/");
};

/**
 * Shared-key gate for the REST API and the Socket.IO handshake.
 *
 *   mode "off"     API_KEY not set        -> everything open (how the server behaved before)
 *   mode "report"  API_KEY set            -> keyless callers are allowed but logged (rollout phase:
 *                                            lets you confirm every client sends the key)
 *   mode "enforce" API_KEY + ENFORCE=true -> keyless callers get 401
 *
 * The key is a random secret kept in an environment variable, never in source control.
 * It is also compiled into the Android app, so it keeps strangers on the internet out;
 * it cannot protect against someone who already has a copy of the APK.
 */
export function createApiGuard({ apiKey, enforce = false, logger = console, now = Date.now }) {
  const mode = !apiKey ? "off" : enforce ? "enforce" : "report";
  const lastReported = new Map();

  const report = (what) => {
    const t = now();
    if (t - (lastReported.get(what) ?? 0) < 10 * 60 * 1000) return; // once per 10 min per route
    lastReported.set(what, t);
    logger.warn(`[auth-${mode}] request without a valid API key: ${what}`);
  };

  return {
    mode,

    http(req, res, next) {
      if (mode === "off" || isOpenPath(req.path)) return next();
      if (safeEqual(req.get("x-api-key"), apiKey)) return next();
      report(`${req.method} ${req.path}`);
      if (mode === "report") return next();
      return res.status(401).json({ error: "Unauthorized" });
    },

    socket(socket, next) {
      if (mode === "off") return next();
      if (safeEqual(socket.handshake?.auth?.key, apiKey)) return next();
      report("socket.io connect");
      if (mode === "report") return next();
      return next(new Error("unauthorized"));
    },
  };
}
