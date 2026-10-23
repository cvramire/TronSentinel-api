# Datos crudos (no versionados)

Los eventos on-chain crudos ocupan varios GB (NDJSON por wallet y por contrato) y **no se suben a GitHub**
(`.gitignore` excluye `TronSentinel-data/` y `*.ndjson`). Se guardan fuera del repositorio, en una carpeta hermana
`TronSentinel-data/`.

| Conjunto crudo | Contenido | Script que lo genera |
|---|---|---|
| `blacklist-history*/`, `blacklist-actions*/` | Eventos `AddedBlackList` / `RemovedBlackList` del contrato USDT | `npm run risk:blacklist-history`, `risk:blacklist-actions`, `risk:blacklist-resolve` |
| `onchain-risk-set-*-sampling/` | Casos y controles seleccionados por fecha índice | `npm run onchain:cohort:positives`, `node scripts/prepare-risk-set-controls-v5.mjs` |
| `onchain-*-history/` | Transferencias USDT/TUSD de 90 días por wallet (TronGrid) | `npm run onchain:history` |
| `onchain-*-consolidated/` | Historiales completos y deduplicados | `npm run onchain:consolidate` |
| `onchain-*-features/` | Variables por wallet | `npm run onchain:features` |

Para regenerar todo el pipeline, ver los comandos completos en [`docs/TRAINING_RUNBOOK.md`](../../docs/TRAINING_RUNBOOK.md).
Se necesita una clave de TronGrid en `functions/.env` (`APP_TRONGRID_API_KEY`).
