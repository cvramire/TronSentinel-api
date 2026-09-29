import {Router} from "express";

export function healthRouter(): Router {
  const router = Router();
  router.get("/health", (_request, response) => {
    response.json({
      ok: true,
      service: "TRONSENTINEL",
      runtime: "nodejs22",
      architecture: "single-classifier",
    });
  });
  return router;
}
