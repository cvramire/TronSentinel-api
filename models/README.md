# Modelos

| Archivo | Qué es | Cómo se usa |
|---|---|---|
| `model_v0.6.1.json` | **Artefacto desplegado** `tronsentinel-onchain-riskset-v0.6.1-20260928`: 150 stumps, calibrador Platt y umbrales. Es el que ejecuta la API (artefacto SHADOW `tronsentinel-wallet-shadow-v0.7.0-20260928`). | `src.model.load_model()` · `app/app.py` |
| `best_model.pkl` | Mejor modelo como objeto Python (`src.model.TronSentinelModel`): el mismo GB de stumps reentrenado con `python -m src.train`, con su calibrador y umbral. Reproduce el JSON con diferencia máxima de probabilidad < 1e-15. | `joblib.load("models/best_model.pkl")` |
| `model_v1.pkl` | **Versión anterior / baseline v1**: regresión logística sobre `log1p` + estandarización, con umbral elegido en validación (FPR ≤ 5 %). Sirve de referencia en la comparación con baseline. | `joblib.load(...)["pipeline"]` |

## Configuración del modelo desplegado

| Parámetro | Valor |
|---|---|
| Algoritmo | `GradientBoostingClassifier` (scikit-learn) con pesos balanceados por clase |
| `n_estimators` | 150 |
| `learning_rate` | 0,04 |
| `max_depth` | 1 (stumps; el scorer TypeScript solo admite profundidad 1) |
| `min_samples_leaf` | 20 |
| `subsample` | 0,8 |
| Semilla | 20260927 |
| Calibración | Platt: `p = sigmoid(1,849 · logit − 1,944)`, ajustada en validación |
| Umbral de revisión | 0,4288828973999436 (máximo F1 en validación con FPR ≤ 5 %) |

## Uso rápido

```python
import joblib, pandas as pd
from src.data_processing import FEATURE_NAMES

modelo = joblib.load("models/best_model.pkl")
wallets = pd.read_csv("app/assets/ejemplo_wallets.csv")
probabilidad = modelo.predict_proba(wallets[FEATURE_NAMES])   # probabilidad muestral caso-control
revision = modelo.predict(wallets[FEATURE_NAMES])             # 1 = recomendar revisión humana
factores = modelo.explain(wallets[FEATURE_NAMES], top=5)       # contribución de cada variable al logit
```

> Los `.pkl` requieren las versiones de `requirements.txt` (scikit-learn 1.9.1). Si cambian, regenerarlos con
> `python -m src.train`. Nunca cargar `.pkl` de fuentes no confiables.

## Historial de versiones

| Versión | Fecha | Estado | Nota |
|---|---|---|---|
| v0.3.x | 27-sep-2026 | Retirada | Cohortes iniciales; controles no emparejados en el tiempo |
| v0.5.x | 28-sep-2026 | Retirada | Piloto del diseño risk set |
| v0.6.0 | 28-sep-2026 | Retirada | Primer modelo risk set v6 |
| **v0.6.1** | 28-sep-2026 | **Desplegada (SHADOW)** | Aprobó robustez y holdout externo de una sola apertura |
| v0.7.0-candidate | 23-oct-2026 | Rechazada (`FAILED_INTERNAL_TEST`) | Sin `daysSinceLastTransfer`; recall IC inferior 0,40 (`governance/cycles/v7/`) |
