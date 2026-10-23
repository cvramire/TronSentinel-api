import admin from "firebase-admin";
import {NextFunction, Request, Response, Router} from "express";
import {ApiError} from "../middleware/errors";
import {getShadowModel, publicShadowModel} from "../repositories/model-repository";
import {scoreWalletShadowLive} from "../risk/scoring-service";

/**
 * Modo demostración público.
 *
 * Solo evalúa una lista fija de wallets del holdout externo, en la fecha previa a su
 * etiquetado, con el mismo modelo y el mismo pipeline en vivo que la ruta protegida.
 * Nunca acepta direcciones arbitrarias: el uso libre del evaluador sigue requiriendo clave.
 */
export interface DemoExample {
  id: string;
  title: string;
  description: string;
  address: string;
  asOf: string;
  groundTruth: "BLACKLISTED_LATER" | "ACTIVE_CONTROL";
  expectedOutcome: "TRUE_POSITIVE" | "TRUE_NEGATIVE" | "FALSE_NEGATIVE" | "FALSE_POSITIVE" | "NOT_SCORABLE";
}

export const DEMO_EXAMPLES: DemoExample[] = [
  {
    id: "detected-risk",
    title: "Wallet riesgosa detectada",
    description: "Incluida en la blacklist de Tether después de esta fecha. El modelo la marca para revisión.",
    address: "TY4D33GnRACD8gnXyDhLnDpbeYaT8SY55D",
    asOf: "2026-06-01T14:40:12.000Z",
    groundTruth: "BLACKLISTED_LATER",
    expectedOutcome: "TRUE_POSITIVE",
  },
  {
    id: "legit-wallet",
    title: "Wallet legítima",
    description: "Control activo sin inclusión conocida. El modelo no recomienda revisión.",
    address: "TAypWU9tyKttnfjt89J8ArHwSSuNWcV9uj",
    asOf: "2026-05-29T14:26:33.000Z",
    groundTruth: "ACTIVE_CONTROL",
    expectedOutcome: "TRUE_NEGATIVE",
  },
  {
    id: "missed-risk",
    title: "Riesgosa no detectada (limitación)",
    description: "Fue incluida en la blacklist, pero mueve poco volumen y el modelo no la detecta. Ilustra la sub-detección en wallets de bajo volumen.",
    address: "TRvdcL6Vwdst8bk9kkPQ4ragmBSkiFt4tG",
    asOf: "2026-06-01T14:40:03.000Z",
    groundTruth: "BLACKLISTED_LATER",
    expectedOutcome: "FALSE_NEGATIVE",
  },
  {
    id: "false-alarm",
    title: "Falsa alarma (limitación)",
    description: "Control legítimo que el modelo marca para revisión. Muestra por qué toda alerta requiere revisión humana.",
    address: "TF7jUttenzFWTqRzXaKSRoC5Y4LAsXCpX3",
    asOf: "2026-06-01T14:53:30.000Z",
    groundTruth: "ACTIVE_CONTROL",
    expectedOutcome: "FALSE_POSITIVE",
  },
  {
    id: "no-activity",
    title: "Sin actividad USDT (no evaluable)",
    description: "Sin transferencias USDT/TUSD en la ventana de 90 días. El sistema se niega a emitir un score.",
    address: "TQboXzEoLRrMjDc49jKKz7uHbYVsQVzNSe",
    asOf: "2026-06-01T14:40:06.000Z",
    groundTruth: "ACTIVE_CONTROL",
    expectedOutcome: "NOT_SCORABLE",
  },
];

/** Limitador en memoria por IP (la función corre con maxInstances = 1). */
export function createRateLimiter(maxRequests: number, windowMs: number, now: () => number = Date.now) {
  const hits = new Map<string, number[]>();
  return function allow(key: string): boolean {
    const current = now();
    const recent = (hits.get(key) || []).filter((time) => current - time < windowMs);
    if (recent.length >= maxRequests) {
      hits.set(key, recent);
      return false;
    }
    recent.push(current);
    hits.set(key, recent);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

export function findExample(id: unknown): DemoExample {
  const example = DEMO_EXAMPLES.find((item) => item.id === String(id || ""));
  if (!example) throw new ApiError(400, "UNKNOWN_EXAMPLE", "El ejemplo solicitado no existe.");
  return example;
}

function publicExample(example: DemoExample) {
  return {...example};
}

const CACHE_MS = 6 * 60 * 60 * 1000;

export function demoRouter(db: admin.firestore.Firestore): Router {
  const router = Router();
  const allow = createRateLimiter(Number(process.env.APP_DEMO_RATE_LIMIT || 30), 10 * 60 * 1000);
  const cache = new Map<string, {expiresAt: number; status: number; body: object}>();

  router.use((request: Request, response: Response, next: NextFunction) => {
    if (!allow(request.ip || "unknown")) {
      response.status(429).json({error: "DEMO_RATE_LIMITED", message: "Demasiadas consultas de demostración. Intenta en unos minutos."});
      return;
    }
    next();
  });

  router.get("/examples", (_request: Request, response: Response) => {
    response.json({examples: DEMO_EXAMPLES.map(publicExample)});
  });

  router.get("/model", async (_request: Request, response: Response, next: NextFunction) => {
    try { response.json(publicShadowModel(await getShadowModel(db))); } catch (error) { next(error); }
  });

  router.post("/score", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const example = findExample(request.body?.exampleId);
      const cached = cache.get(example.id);
      if (cached && cached.expiresAt > Date.now()) {
        response.status(cached.status).json(cached.body);
        return;
      }
      let status = 200;
      let body: object;
      try {
        const result = await scoreWalletShadowLive(db, {address: example.address, asOf: example.asOf});
        // Se muestra la dirección completa para que la evaluación sea verificable en el explorador público.
        body = {...result, demo: publicExample(example)};
      } catch (error) {
        if (!(error instanceof ApiError) || error.status !== 422) throw error;
        status = 422;
        body = {error: error.code, message: error.message, demo: publicExample(example)};
      }
      cache.set(example.id, {expiresAt: Date.now() + CACHE_MS, status, body});
      response.status(status).json(body);
    } catch (error) {
      next(error);
    }
  });

  return router;
}
