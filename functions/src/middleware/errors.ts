import {NextFunction, Request, Response} from "express";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function notFoundHandler(request: Request, response: Response): void {
  response.status(404).json({
    error: "ROUTE_NOT_FOUND",
    message: `No existe la ruta ${request.method} ${request.path}.`,
  });
}

export function errorHandler(
  error: Error,
  _request: Request,
  response: Response,
  _next: NextFunction,
): void {
  if (error instanceof ApiError) {
    response.status(error.status).json({error: error.code, message: error.message});
    return;
  }

  console.error("Unhandled TronSentinel API error", error);
  response.status(500).json({
    error: "INTERNAL_ERROR",
    message: "No fue posible completar la evaluación.",
  });
}
