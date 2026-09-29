import admin from "firebase-admin";
import {NextFunction, Request, Response, Router} from "express";
import {
  scoreWallet,
  scoreWalletShadow,
  scoreWalletShadowLive,
} from "../risk/scoring-service";

export function walletScoreRouter(db: admin.firestore.Firestore): Router {
  const router = Router();
  router.post("/shadow/live", async (request: Request, response: Response, next: NextFunction) => {
    try { response.json(await scoreWalletShadowLive(db, request.body || {})); } catch (error) { next(error); }
  });
  router.post("/shadow", async (request: Request, response: Response, next: NextFunction) => {
    try { response.json(await scoreWalletShadow(db, request.body || {})); } catch (error) { next(error); }
  });
  router.post("/", async (request: Request, response: Response, next: NextFunction) => {
    try {
      const result = await scoreWallet(db, request.body || {});
      response.json(result);
    } catch (error) {
      next(error);
    }
  });
  return router;
}
