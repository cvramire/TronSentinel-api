import admin from "firebase-admin";
import {NextFunction, Request, Response, Router} from "express";
import {getChampionModel, getShadowModel, publicModel, publicShadowModel} from "../repositories/model-repository";

export function modelRouter(db: admin.firestore.Firestore): Router {
  const router = Router();
  router.get("/shadow", async (_request: Request, response: Response, next: NextFunction) => {
    try { response.json(publicShadowModel(await getShadowModel(db))); } catch (error) { next(error); }
  });
  router.get("/", async (_request: Request, response: Response, next: NextFunction) => {
    try {
      const model = await getChampionModel(db);
      response.json(publicModel(model));
    } catch (error) {
      next(error);
    }
  });
  return router;
}
