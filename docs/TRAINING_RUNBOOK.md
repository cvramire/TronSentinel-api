# Runbook de entrenamiento — candidato v0.7.x (con comandos)

Las reglas están en [`TRAINING_GOVERNANCE.md`](./TRAINING_GOVERNANCE.md).

**Deploy:** no hace falta `firebase deploy` en ninguna fase. Solo la fase 6 escribe en Firestore, y la API lee el modelo activo desde ahí.

## Variables de sesión (en cada terminal nueva)

```bash
cd ~/Desktop/TronSentinel-api/functions
export DATA=~/Desktop/TronSentinel-data
export TRONGRID_API_KEY=<tu_clave_trongrid>
export V=v7                                   # sufijo de esta cohorte
export MV=tronsentinel-onchain-riskset-v0.7.0-$(date +%Y%m%d)
export AV=tronsentinel-wallet-shadow-v0.8.0-$(date +%Y%m%d)
```

---

## Fase 0 — Preparación (una vez)

```bash
python3 -m pip install numpy pandas scikit-learn matplotlib
npm install
npm run test:governance        # 14 pruebas OK

cd .. && git checkout -b governance/training-v2
git add README.md docs governance functions/package.json functions/scripts
git commit -m "Gobernanza de entrenamiento y scripts del ciclo v0.7"
git push -u origin governance/training-v2
cd functions
```

## Fase A — Ensayo opcional con los datos actuales (no genera candidato)

```bash
npm run onchain:model:train -- \
  --dataset  $DATA/onchain-risk-set-v6-development-dataset/onchain-feature-dataset.csv \
  --manifest $DATA/onchain-risk-set-v6-development-dataset/onchain-feature-manifest.json \
  --output-dir $DATA/onchain-model-exploratorio \
  --model-version tronsentinel-onchain-exploratorio
```

---

## Fase 1 — Etiquetas y casos positivos nuevos

### 1.1 Actualizar la blacklist

```bash
npm run risk:blacklist-history -- --output $DATA/blacklist-history-$V
npm run risk:blacklist-actions -- --input  $DATA/blacklist-history-$V/tronscan-blacklist-history.csv --output $DATA/blacklist-actions-$V
npm run risk:blacklist-resolve -- --input  $DATA/blacklist-actions-$V/tronscan-blacklist-actions.csv --output $DATA/blacklist-final-$V
export LABELS=$DATA/blacklist-final-$V/blacklist-label-events-final.csv
```

### 1.2 Cohorte de positivos posteriores al 9 de junio de 2026

Los controles salen del risk set en la Fase 2, así que la cohorte contiene solo positivos y no necesita archivo de eventos. La fecha índice es la primera inclusión conocida de cada dirección, y quedan excluidas las direcciones usadas en cohortes anteriores.

```bash
npm run onchain:cohort:positives -- \
  --labels $LABELS \
  --from 2026-06-10T00:00:00Z --to 2026-09-20T00:00:00Z \
  --positive-limit 700 --seed tronsentinel-onchain-$V \
  --exclude $DATA/tronsentinel-onchain-cohort-v1/onchain-cohort.csv \
  --exclude $DATA/onchain-risk-set-v6-development-dataset/onchain-feature-dataset.csv \
  --exclude $DATA/onchain-model-risk-set-v0.6.1-external-holdout/external-holdout-dataset.csv \
  --output-dir $DATA/tronsentinel-onchain-cohort-$V
```

### 1.3 Historia y variables de los positivos

```bash
COH=$DATA/tronsentinel-onchain-cohort-$V/onchain-cohort.csv
npm run onchain:history -- --cohort $COH --output-dir $DATA/onchain-history-$V --lookback-days 90 --max-wallets 10   # piloto
npm run onchain:history -- --cohort $COH --output-dir $DATA/onchain-history-$V --lookback-days 90                   # completo (reanudable)
npm run onchain:consolidate -- --cohort $COH --source-dir $DATA/onchain-history-$V \
  --output-dir $DATA/onchain-consolidated-$V --lookback-days 90
npm run onchain:features -- \
  --wallets   $DATA/onchain-consolidated-$V/onchain-wallets-consolidated.csv \
  --transfers $DATA/onchain-consolidated-$V/onchain-transfers-complete.ndjson \
  --history-status COMPLETE --lookback-days 90 \
  --output-dir $DATA/onchain-features-$V
```

### 1.4 Separar el holdout externo (antes de mirar nada)

Los casos más recientes van al holdout externo:

```bash
npm run onchain:cases:split -- \
  --features $DATA/onchain-features-$V/onchain-feature-dataset.csv \
  --external-count 100 \
  --output-dir $DATA/onchain-cases-$V
```

Genera `cases-development.csv`, `cases-external.csv` y `case-split-summary.json` (con fechas y hashes). Haz commit del resumen. El holdout queda bloqueado hasta la fase 5.

---

## Fase 2 — Controles por risk set

### 2.1 Muestrear controles

```bash
EXCL="--exclude $DATA/onchain-features-v1.1/onchain-feature-dataset.csv \
 --exclude $DATA/onchain-risk-set-v6-development-dataset/onchain-feature-dataset.csv \
 --exclude $DATA/onchain-model-risk-set-v0.6.1-external-holdout/external-holdout-dataset.csv \
 --exclude validation/onchain-control-pool-v2.csv \
 --exclude $DATA/onchain-control-pool-v3-consolidated/onchain-control-pool-v3-wallets.csv \
 --exclude $DATA/onchain-control-pilot-v4-consolidated/onchain-control-pilot-v4-wallets.csv \
 --exclude $DATA/onchain-risk-set-v5-pilot/risk-set-development-controls-v5.csv \
 --exclude $DATA/onchain-risk-set-v5-additional-sampling/risk-set-development-controls-v5.csv \
 --exclude $DATA/onchain-risk-set-v6-external-corrected-sampling-v2/risk-set-external-holdout-v5.csv"

# Desarrollo: 4 controles por caso
npm run onchain:risk-set -- --cases $DATA/onchain-cases-$V/cases-development.csv --labels $LABELS \
  $EXCL --exclude $DATA/onchain-cases-$V/cases-external.csv \
  --development-per-case 4 --holdout-per-case 0 \
  --seed tronsentinel-risk-set-$V-dev --output-dir $DATA/onchain-risk-set-$V-dev-sampling

# Externo: 2 controles por caso. El script exige al menos 1 de desarrollo; esa fila se descarta.
npm run onchain:risk-set -- --cases $DATA/onchain-cases-$V/cases-external.csv --labels $LABELS \
  $EXCL --exclude $DATA/onchain-cases-$V/cases-development.csv \
  --exclude $DATA/onchain-risk-set-$V-dev-sampling/risk-set-development-controls-v5.csv \
  --development-per-case 1 --holdout-per-case 2 \
  --seed tronsentinel-risk-set-$V-ext --output-dir $DATA/onchain-risk-set-$V-ext-sampling
```

Puedes añadir `--dry-run` a cualquiera de los dos para revisar antes de descargar.

### 2.2 Historia y variables de los controles

Controles de desarrollo:

```bash
C=$DATA/onchain-risk-set-$V-dev-sampling/risk-set-development-controls-v5.csv
npm run onchain:history -- --cohort $C --output-dir $DATA/onchain-risk-set-$V-dev-history --lookback-days 90
npm run onchain:consolidate -- --cohort $C --source-dir $DATA/onchain-risk-set-$V-dev-history \
  --output-dir $DATA/onchain-risk-set-$V-dev-consolidated --lookback-days 90
npm run onchain:features -- \
  --wallets   $DATA/onchain-risk-set-$V-dev-consolidated/onchain-wallets-consolidated.csv \
  --transfers $DATA/onchain-risk-set-$V-dev-consolidated/onchain-transfers-complete.ndjson \
  --history-status COMPLETE --lookback-days 90 --output-dir $DATA/onchain-risk-set-$V-dev-features
```

Controles externos: solo el archivo `external-holdout`.

```bash
C=$DATA/onchain-risk-set-$V-ext-sampling/risk-set-external-holdout-v5.csv
npm run onchain:history -- --cohort $C --output-dir $DATA/onchain-risk-set-$V-ext-history --lookback-days 90
npm run onchain:consolidate -- --cohort $C --source-dir $DATA/onchain-risk-set-$V-ext-history \
  --output-dir $DATA/onchain-risk-set-$V-ext-consolidated --lookback-days 90
npm run onchain:features -- \
  --wallets   $DATA/onchain-risk-set-$V-ext-consolidated/onchain-wallets-consolidated.csv \
  --transfers $DATA/onchain-risk-set-$V-ext-consolidated/onchain-transfers-complete.ndjson \
  --history-status COMPLETE --lookback-days 90 --output-dir $DATA/onchain-risk-set-$V-ext-features
```

### 2.3 Ensamblar los datasets

Desarrollo (partición cronológica agrupada 70/15/15):

```bash
npm run onchain:dataset:assemble -- --mode development \
  --cases $DATA/onchain-cases-$V/cases-development.csv \
  --controls-features $DATA/onchain-risk-set-$V-dev-features/onchain-feature-dataset.csv \
  --controls-manifest $DATA/onchain-risk-set-$V-dev-features/onchain-feature-manifest.json \
  --exclude $DATA/onchain-cases-$V/cases-external.csv \
  --exclude $DATA/onchain-risk-set-v6-development-dataset/onchain-feature-dataset.csv \
  --exclude $DATA/onchain-model-risk-set-v0.6.1-external-holdout/external-holdout-dataset.csv \
  --dataset-version tronsentinel-risk-set-$V-development-1.0.0 \
  --output-dir $DATA/onchain-risk-set-$V-development-dataset
```

Holdout externo (bloqueado; no se mira):

```bash
npm run onchain:dataset:assemble -- --mode external \
  --cases $DATA/onchain-cases-$V/cases-external.csv \
  --controls-features $DATA/onchain-risk-set-$V-ext-features/onchain-feature-dataset.csv \
  --controls-manifest $DATA/onchain-risk-set-$V-ext-features/onchain-feature-manifest.json \
  --exclude $DATA/onchain-risk-set-$V-development-dataset/onchain-feature-dataset.csv \
  --exclude $DATA/onchain-risk-set-v6-development-dataset/onchain-feature-dataset.csv \
  --dataset-version tronsentinel-risk-set-$V-external-1.0.0 \
  --output-dir $DATA/onchain-risk-set-$V-external-dataset
```

Atajos para las fases siguientes:

```bash
export DEV=$DATA/onchain-risk-set-$V-development-dataset
export EXT=$DATA/onchain-risk-set-$V-external-dataset
export OUT=$DATA/onchain-model-risk-set-$V
```

---

## Fase 3 — Selección y entrenamiento (solo validación)

### 3.1 Diagnóstico de regularización

Usa 30 semillas y 5.000 repeticiones de bootstrap; tarda varios minutos.

```bash
npm run onchain:model:diagnose -- \
  --dataset $DEV/onchain-feature-dataset.csv --manifest $DEV/onchain-feature-manifest.json \
  --output-dir ../reports/overfitting-$V
python3 -c "import json;d=json.load(open('../reports/overfitting-$V/diagnosis_v2.json'));print(d['diagnosis']['diagnosis'], d['selection']['conclusion'])"
```

### 3.2 Entrenar el candidato

```bash
npm run onchain:model:train -- \
  --dataset $DEV/onchain-feature-dataset.csv --manifest $DEV/onchain-feature-manifest.json \
  --output-dir $OUT --model-version $MV
```

### 3.3 Revisar el resultado

```bash
python3 - <<EOF
import json
r = json.load(open("$OUT/training-report-onchain.json"))
s = r["estimatorSelection"]
print("decision         ", r["promotion"]["decision"])
print("checks           ", r["promotion"]["checks"])
print("estimadores      ", s["estimators"], "| stoppedEarly:", s["rule"]["stoppedEarly"])
print("semillas         ", {k: v for k, v in s["seedStability"].items() if k != "runs"})
v = r["splits"]["validation"]
print("PR-AUC val / nulo", round(v["prAuc"], 4), "/", round(v["nullPrAuc"], 4))
print("recall / FPR val ", v["controlledFprOperatingPoint"]["recall"], v["controlledFprOperatingPoint"]["falsePositiveRate"])
EOF
```

Si `stoppedEarly` es `False`, repite el paso 3.2 con `--max-estimators 2000`. Si la decisión es `REJECTED`, corrige usando solo validación.

---

## Fase 4 — Congelar y abrir el test interno (una vez)

```bash
npm run onchain:model:freeze -- --model-dir $OUT \
  --dataset $DEV/onchain-feature-dataset.csv --manifest $DEV/onchain-feature-manifest.json

npm run onchain:model:confirm-test -- \
  --model $OUT/model-challenger-onchain.json --dataset $DEV/onchain-feature-dataset.csv \
  --partition internal-test --output-dir $OUT --purpose "Confirmación interna $MV"

npm run onchain:robustness -- \
  --dataset $DEV/onchain-feature-dataset.csv --manifest $DEV/onchain-feature-manifest.json \
  --model $OUT/model-challenger-onchain.json --output-dir $OUT-robustness

python3 -c "import json;print(json.load(open('$OUT/internal-test-confirmation.json'))['decision']); print(json.load(open('$OUT-robustness/robustness-report.json'))['governance']['decision'])"

cd .. && git add governance/data-openings.json && git commit -m "Apertura test interno $MV" && cd functions
```

Para continuar se necesita `PASSED_INTERNAL_TEST_…` **y** `APPROVED_FOR_SCORE_CALIBRATION`. Si cualquiera de los dos falla, el ciclo termina y v0.6.1 sigue activo.

---

## Fase 5 — Holdout externo nuevo (una vez)

```bash
npm run onchain:model:confirm-test -- \
  --model $OUT/model-challenger-onchain.json --dataset $EXT/external-holdout-dataset.csv \
  --partition external-holdout --output-dir $OUT-external --purpose "Holdout externo $MV"

python3 -c "import json;print(json.load(open('$OUT-external/external-holdout-confirmation.json'))['decision'])"
cd .. && git add governance/data-openings.json && git commit -m "Apertura holdout externo $MV" && cd functions
```

Para continuar se necesita `PASSED_EXTERNAL_HOLDOUT_ELIGIBLE_FOR_SHADOW_REVIEW`.

---

## Fase 6 — Paso a SHADOW (único paso que escribe en Firestore)

```bash
# 6.1 Calibrar el score percentil (todavía no habilita el despliegue)
npm run onchain:calibrate-score -- \
  --dataset $DEV/onchain-feature-dataset.csv --manifest $DEV/onchain-feature-manifest.json \
  --model $OUT/model-challenger-onchain.json --robustness $OUT-robustness/robustness-report.json \
  --artifact-version $AV --label-version tronsentinel-blacklist-labels-$V \
  --output-dir $DATA/onchain-shadow-$V

# 6.2 Sellar: verifica modelo congelado, ambas confirmaciones y el ledger
npm run onchain:shadow:seal -- \
  --shadow-model $DATA/onchain-shadow-$V/wallet-shadow-model.json \
  --challenger $OUT/model-challenger-onchain.json \
  --internal-confirmation $OUT/internal-test-confirmation.json \
  --external-confirmation $OUT-external/external-holdout-confirmation.json

# 6.3 Importar: primero el ensayo, luego escribir y luego activar
A=$DATA/onchain-shadow-$V/wallet-shadow-model-external-approved.json
npm run onchain:shadow:import -- --model $A --dataset $DEV/onchain-feature-dataset.csv --project-id pry-tronsentinel
npm run onchain:shadow:import -- --model $A --dataset $DEV/onchain-feature-dataset.csv --project-id pry-tronsentinel --commit
npm run onchain:shadow:import -- --model $A --dataset $DEV/onchain-feature-dataset.csv --project-id pry-tronsentinel --commit --activate
```

6.4 Verificar:

```bash
curl -s -H "x-api-key: <tu_api_key>" https://<url-de-tu-funcion>/v1/model
```

Debe mostrar la nueva `artifactVersion`. Después actualiza `docs/MODEL_CARD.md`.

**Rollback:** en Firestore, `ts_model_control/current.shadowModelVersion = tronsentinel-wallet-shadow-v0.7.0-20260928`.
