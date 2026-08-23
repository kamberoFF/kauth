import { randomUUID } from "node:crypto";
import { type RequestHandler } from "express";
import { logger } from "../lib/logger";

function outcomeLevel(statusCode: number) {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warn";
  return "info";
}

/**
 * Mints a request id, never trusted from an inbound header — this repo has
 * no existing tracing-header convention, and honoring an unvalidated one is
 * log-injection surface for a feature nobody's asked for. Logs on `finish`
 * rather than at dispatch time so it fires after routing and after any error
 * handler has run, picking up `req.userId`/`req.sessionId` however late in
 * the chain they get set.
 */
export const requestLog: RequestHandler = (req, res, next) => {
  req.requestId = randomUUID();
  const startedAt = performance.now();

  res.on("finish", () => {
    logger[outcomeLevel(res.statusCode)]("request completed", {
      requestId: req.requestId,
      method: req.method,
      route: req.route?.path ?? req.path,
      statusCode: res.statusCode,
      durationMs: Math.round(performance.now() - startedAt),
      userId: req.userId,
      sessionId: req.sessionId,
    });
  });

  next();
};
