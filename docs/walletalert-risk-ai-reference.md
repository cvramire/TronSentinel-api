# Wallet Alert Risk AI Backend 1.1

This backend implements the controlled learning cycle defined by the Wallet Alert risk model.

## Runtime flow

1. Incoming TRON USDT events are normalized and evaluated by the existing Bayes engine.
2. A deterministic score is calculated from the same point-in-time features.
3. If a production champion exists and drift is not severe, the supervised model returns a calibrated probability.
4. The final score combines deterministic rules, Bayes, AI, sender risk, and receiver risk.
5. Critical labels and invalid security checks impose a minimum high-risk score.
6. A daily point-in-time snapshot is saved for later delayed-label training.
7. If AI is unavailable, low-confidence, or unsafe, the API records the fallback reason and continues with deterministic and Bayes scoring.

## Firestore collections

| Collection | Purpose |
| --- | --- |
| `feature_snapshots` | Daily point-in-time wallet feature vectors. |
| `label_history` | Immutable blacklist label history with source and effective dates. |
| `addressLabels` | Current operational label used by online scoring. |
| `training_runs` | Training status, dataset lineage, metrics, and errors. |
| `model_registry` | Challenger, champion, and archived model artifacts. |
| `model_registry_control/current` | Pointer to the current champion. |
| `risk_model_monitoring` | Drift checks and monitoring evidence. |

## Delayed labels

For a snapshot at time `T`, a positive label is assigned only when a blacklist event occurs after `T` and no later than `T + horizon`. Data published after the snapshot is never added to the feature vector. Unlabeled snapshots become training negatives only after the prediction horizon plus the maturity margin has elapsed.

## Administrative security

The risk administration API accepts either:

- a Firebase ID token with the custom claim `riskAdmin: true` or `admin: true`; or
- the `x-risk-admin-secret` header matching `APP_RISK_ADMIN_SECRET`.

Use Firebase custom claims for human administrators. Reserve the secret for trusted internal jobs and store it in Secret Manager.

## Administrative endpoints

| Method and route | Purpose |
| --- | --- |
| `POST /v1/admin/risk/labels` | Ingest up to 500 versioned blacklist labels. |
| `POST /v1/admin/risk/train` | Train and register a challenger using a temporal split. |
| `GET /v1/admin/risk/models` | List recent model versions and metrics. |
| `POST /v1/admin/risk/models/:version/promote` | Promote only when quality gates pass. |
| `POST /v1/admin/risk/models/:version/rollback` | Reactivate an archived model. |
| `POST /v1/admin/risk/drift/check` | Compare recent features with the champion baseline. |

Example label payload:

```json
{
  "labels": [
    {
      "address": "T...",
      "source": "approved-provider",
      "category": "BLACKLIST",
      "publishedAt": "2026-09-19T10:00:00Z",
      "effectiveAt": "2026-09-19T10:00:00Z",
      "labelConfidence": 0.95,
      "evidenceRef": "case-or-provider-reference"
    }
  ]
}
```

## Scheduled maintenance

`riskModelMaintenance` runs every Monday at 03:00 in `America/Guayaquil`. It checks drift and may create a challenger when needed. It never promotes a model automatically.

## Quality gates

Promotion requires minimum validation size and positives, PR AUC, Brier score, recall, false-positive-rate limits, and no material regression against the current champion. Every deployment remains reversible.

## Deployment

From `Endpoints`:

```bash
firebase deploy --only firestore:indexes
firebase deploy --only functions
```

Before deployment:

```bash
cd functions
npm ci
npm run typecheck
npm run test:risk-ai
```

The first model cannot be trained until enough matured snapshots and delayed positive labels exist. Until then, the online engine explicitly uses its deterministic and Bayes fallback.

## Historical data export

The repository includes a read-only exporter for the historical discrimination analysis and the future training dataset. It exports these collections by default:

- `intelligenceAlerts`: legacy decisions and accumulated alert history;
- `feature_snapshots`: point-in-time model features; and
- `label_history`: delayed blacklist labels.

It creates lossless NDJSON, flattened CSV files, and a `manifest.json` with counts, date ranges, observed fields, file sizes, and SHA-256 hashes. User identifiers are redacted by default. Blockchain addresses remain because they are required to join snapshots and delayed labels. Secrets and private keys are always redacted.

Use a service account with the minimum Firestore read-only permissions. Do not use an owner credential or commit the credential file.

```bash
cd Endpoints/functions
export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/firestore-readonly.json
npm run export:risk-data -- \
  --project-id walletalert-f063b \
  --output ./exports/risk-data-full
```

To include audit collections used to reconcile the score shown by the platform:

```bash
npm run export:risk-data -- \
  --project-id walletalert-f063b \
  --include-audit \
  --output ./exports/risk-data-with-audit
```

Optional date filters use ISO-8601:

```bash
npm run export:risk-data -- \
  --from 2026-01-01T00:00:00Z \
  --to 2026-09-30T23:59:59Z
```

Before using production data:

```bash
npm run test:export-risk-data
npm run export:risk-data -- --help
```

Compress and share the complete generated directory, including `manifest.json`. The manifest allows the dataset processor to confirm completeness and integrity before building labels or training splits.

## External wallet screening and blacklist labels

The repository includes a resumable screening tool. It separates confirmed provider findings from `NOT_FLAGGED_AT_CHECK_TIME`; the latter must never be interpreted as proof that a wallet is permanently clean.

Generate the recommended 1,500-wallet pilot from the processed dataset:

```bash
cd Endpoints/functions
npm run risk:sample -- \
  --input ./dataset/wallet_legacy_pseudolabels.csv \
  --output ./screening/pilot-1500.csv
```

Validate the plan without consuming API credits:

```bash
npm run risk:screen -- \
  --input ./screening/pilot-1500.csv \
  --output ./screening/results-pilot \
  --dry-run
```

Configure credentials only through environment variables and run the checks:

```bash
export APP_TRONSCAN_API_KEY=replace-in-secret-manager
export APP_TATUM_API_KEY=replace-in-secret-manager

npm run risk:screen -- \
  --input ./screening/pilot-1500.csv \
  --output ./screening/results-pilot \
  --providers tronscan,tatum
```

The NDJSON file is append-only and allows the command to resume without repeating successful provider checks. `labels-for-ingestion.json` contains only confirmed blacklist or malicious-address positives and is compatible with the administrative label endpoint. Review it before ingestion.

TRONSCAN also exposes historical stablecoin blacklist transactions. Download them separately because each event must be enriched with its transaction before deciding whether it represents an addition or removal:

```bash
npm run risk:blacklist-history -- \
  --output ./screening/tronscan-blacklist-history
```

Run local validations before using paid APIs:

```bash
npm run test:screen-risk-wallets
npm run risk:screen -- --help
```
