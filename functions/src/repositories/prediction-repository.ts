import crypto from "crypto";
import admin from "firebase-admin";

export async function recordPrediction(
  db: admin.firestore.Firestore,
  prediction: Record<string, unknown>,
): Promise<string> {
  const predictionId = `pred_${Date.now()}_${crypto.randomBytes(6).toString("hex")}`;
  await db.collection("ts_predictions").doc(predictionId).set({
    ...prediction,
    predictionId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return predictionId;
}
