import crypto from "crypto";
import {NextFunction, Request, Response} from "express";

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function apiKeyMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const expectedHash = String(process.env.APP_API_KEY_SHA256 || "").trim();
  if (!expectedHash) {
    if (process.env.FUNCTIONS_EMULATOR === "true") {
      next();
      return;
    }
    response.status(503).json({
      error: "API_KEY_NOT_CONFIGURED",
      message: "La API todavía no tiene una clave de acceso configurada.",
    });
    return;
  }

  const supplied = String(request.header("x-api-key") || "");
  const suppliedHash = sha256(supplied);
  const expected = Buffer.from(expectedHash, "utf8");
  const actual = Buffer.from(suppliedHash, "utf8");

  if (expected.length !== actual.length || !crypto.timingSafeEqual(expected, actual)) {
    response.status(401).json({
      error: "INVALID_API_KEY",
      message: "La clave de acceso no es válida.",
    });
    return;
  }

  next();
}
