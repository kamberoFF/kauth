// Helper to attach HTTP status for your errorHandler
export const appError = (message: string, status: number, cause?: string) => {
  const err = new Error(message, { cause }) as Error & { status: number };
  err.status = status;
  return err;
};
