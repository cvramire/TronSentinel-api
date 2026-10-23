import "dotenv/config";
import express from "express";
import cors from "cors";
import admin from "firebase-admin";
import {onRequest} from "firebase-functions/v2/https";
import {apiKeyMiddleware} from "./middleware/api-key";
import {errorHandler, notFoundHandler} from "./middleware/errors";
import {healthRouter} from "./routes/health";
import {modelRouter} from "./routes/model";
import {transactionScoreRouter} from "./routes/transaction-score";
import {walletScoreRouter} from "./routes/wallet-score";
import {demoRouter} from "./routes/demo";

admin.initializeApp();

const app = express();
const db = admin.firestore();

app.disable("x-powered-by");
app.set("trust proxy", true);
app.use(cors({origin: true}));
app.use(express.json({limit: "256kb"}));

app.use(healthRouter());
// Modo demostración público: solo ejemplos fijos, con límite de uso. No requiere clave.
app.use("/demo", demoRouter(db));
app.use("/v1", apiKeyMiddleware);
app.use("/v1/model", modelRouter(db));
app.use("/v1/score/wallet", walletScoreRouter(db));
app.use("/v1/score/transaction", transactionScoreRouter(db));

app.use(notFoundHandler);
app.use(errorHandler);

export const TRONSENTINEL = onRequest({
  region: "us-central1",
  concurrency: 8,
  minInstances: 0,
  maxInstances: 1,
  memory: "1GiB",
  timeoutSeconds: 300,
  secrets: ["APP_TRONGRID_API_KEY"],
}, app);
