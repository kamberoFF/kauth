import { type ErrorRequestHandler, type RequestHandler } from "express";
import { ZodError } from "zod";
import { Prisma } from "../generated/prisma/client";
import config from "../config";
import { AppError } from "../types/errors";

const isProduction = config.node_env === "production";

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, `Cannot ${req.method} ${req.path}`, "not_found"));
};

function normalize(err: unknown): AppError {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof ZodError) {
    return new AppError(400, "Invalid input", "validation");
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // A unique-constraint violation must never echo the conflicting field:
    // on unauthenticated endpoints that is an account-existence oracle.
    if (err.code === "P2002") {
      return new AppError(409, "Resource already exists", "duplicate_resource");
    }

    if (err.code === "P2025") {
      return new AppError(404, "Resource not found", "not_found");
    }
  }

  return new AppError(500, "Internal Server Error", "internal_error");
}

function clientMessage(original: unknown, normalized: AppError): string {
  if (normalized.statusCode < 500) {
    return normalized.message;
  }

  if (isProduction) {
    return "Internal Server Error";
  }

  return original instanceof Error ? original.message : normalized.message;
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  const normalized = normalize(err);

  if (normalized.statusCode >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }

  res.status(normalized.statusCode).json({
    error: {
      message: clientMessage(err, normalized),
      code: normalized.code ?? "internal_error",
    },
  });
};
