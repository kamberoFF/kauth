import { AppError } from "../types/errors";

export const appError = (status: number, message: string, cause?: string) => {
  const err = new AppError(status, message, cause);
  return err;
};
