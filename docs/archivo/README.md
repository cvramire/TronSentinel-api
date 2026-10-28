# Documentos históricos

Estos documentos describen etapas anteriores del proyecto y **no corresponden al modelo desplegado**
(`tronsentinel-onchain-riskset-v0.6.1-20260928`, 38 variables on-chain, dataset risk set v6). Se conservan como
registro del proceso de diseño.

| Documento | Etapa | Reemplazado por |
|---|---|---|
| `FEATURE_SET_V2.md` | Feature set `tron-wallet-behavior-2.0.0` (ventanas 1/7/30/90 días, patrones de ballenas) | [`data/README.md`](../../data/README.md) · [`MODEL_CARD.md`](../MODEL_CARD.md) |
| `LABELING_PROTOCOL.md` | Etiquetado de snapshots punto en el tiempo con horizonte de 90 días (dataset 0.3.0) | Diseño risk set caso-control: [`data/README.md`](../../data/README.md) · [`TRAINING_RUNBOOK.md`](../TRAINING_RUNBOOK.md) |
| `ONCHAIN_CASE_CONTROL.md` | Primera cohorte caso-control on-chain (controles del mismo mes) | Risk set con controles activos en la misma fecha índice: [`analisis_datos.md`](../analisis_datos.md) |
