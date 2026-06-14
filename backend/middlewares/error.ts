import { type ErrorRequestHandler } from "express";
import config from "../config";

const NODE_ENV = config.node_env;

export const errorHandler: ErrorRequestHandler = async (
  err,
  req,
  res,
  next,
) => {
  console.error(err);

  if (res.headersSent) {
    return next(err);
  }

  const statusCode = err.statusCode || err.status || 500;
  const isProduction = NODE_ENV === "production";

  res.status(statusCode).json({
    error: {
      message:
        statusCode >= 500 && isProduction
          ? "Internal Server Error"
          : err.message || "Internal Server Error",
      code: err.code || "INTERNAL_ERROR",
    },
  });
};
