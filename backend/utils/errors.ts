import { AppError } from "../types/errors";

export const appError = (status: number, message: string, code?: string) =>
  new AppError(status, message, code);
