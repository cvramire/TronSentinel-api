import crypto from "crypto";
import admin from "firebase-admin";
import {FeatureVector} from "../risk/contracts";
import {AmountQuality} from "../risk/onchain-features";

export async function saveLiveShadowSnapshot(
  db: admin.firestore.Firestore,
  input: {
    address: string;
    asOfMs: number;
    featureSetVersion: string;
    features: FeatureVector;
    lookbackDays: number;
    transferCount: number;
    pages: number;
    contracts: readonly string[];
    amountQuality: AmountQuality;
  },
): Promise<string> {
  const digest = crypto.createHash("sha256")
    .update(`${input.address}|${input.asOfMs}|${input.featureSetVersion}`)
    .digest("hex")
    .slice(0, 24);
  const snapshotId = `live_${digest}`;
  await db.collection("ts_onchain_feature_snapshots").doc(snapshotId).set({
    snapshotId,
    address: input.address,
    snapshotAtMs: input.asOfMs,
    featureSetVersion: input.featureSetVersion,
    features: input.features,
    source: "TRONGRID_LIVE",
    historyStatus: "COMPLETE",
    lookbackDays: input.lookbackDays,
    transferCount: input.transferCount,
    providerPages: input.pages,
    contracts: [...input.contracts],
    amountQuality: input.amountQuality,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  }, {merge: true});
  return snapshotId;
}
