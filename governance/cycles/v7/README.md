# Ciclo v7 — informe de cierre

**Decisión:** `FAILED_INTERNAL_TEST_START_NEW_CYCLE_WITH_FUTURE_DATA`
**Candidato:** `tronsentinel-onchain-riskset-v0.7.0-20261023`. Hash del modelo: `59930ec8…c338c`.
**Modelo en producción (SHADOW):** sin cambios. Siguen `tronsentinel-onchain-riskset-v0.6.1-20260928` y el artefacto `tronsentinel-wallet-shadow-v0.7.0-20260928`.
**Deploy:** ninguno.

## 1. Datos

| Elemento | Valor |
|---|---|
| Etiquetas | `blacklist-final-v7`: 8.002 ADD, 0 sin resolver (`trainingSafe: true`) |
| Casos elegibles | 1.198 con primera inclusión entre 2026-06-10 y 2026-09-20 |
| Cohorte de positivos | 700 casos (175 por mes); 698 con historia completa |
| Separación | 548 de desarrollo y 150 externos (los más recientes) |
| Controles | Risk set v5, 4 por caso en desarrollo y 2 por caso en el externo; 6,3 % y 7,3 % censurados |
| Dataset de desarrollo | `bdd3ce69…`: 2.601 filas, 548 positivos, prevalencia 0,2107 |
| Particiones | train 384 casos, validation 82, test 82 (cronológica agrupada 70/15/15) |
| Holdout externo | `545a8e75…`: 426 filas, 148 positivos. **Nunca abierto.** |

## 2. Selección (solo validación)

**Diagnóstico (30 semillas, 5.000 bootstrap):** `GENERALIZACION_ADECUADA`. La base compleja (profundidad 3) superó a la combinada por +0,014 de PR-AUC, con IC [0,0015; 0,029]. No se adoptó por dos razones: el scorer productivo solo admite stumps, restricción definida de antemano, y la comparación se hizo con 150 estimadores, no con early stopping. Se registra como hallazgo para ciclos futuros.

**Hallazgo crítico: sesgo de selección en `daysSinceLastTransfer`.** El risk set v5 elige controles con una transferencia en los 300 segundos previos a la fecha índice. En train:

| | Mediana (días) | Proporción < 0,01 días |
|---|---|---|
| Casos | 3,53 | 1,8 % |
| Controles | 0,00 | 66,4 % |

AUC univariado: 0,90. Importancia en el primer candidato: 70 %. La variable refleja en buena parte el diseño de muestreo, y el holdout externo comparte ese diseño, así que no puede detectarlo. **Afecta también a v0.6.1**, donde su importancia era 49,7 %.

**Regla fijada antes de ver resultados:** entrenar sin `daysSinceLastTransfer` (`--neutralize-features`) y congelar si cumple `READY_FOR_FREEZE`, descartando el modelo que la usa sin importar su desempeño.

| Validación | Con recencia (descartado) | Sin recencia (congelado) |
|---|---|---|
| PR-AUC | 0,940 | 0,834 [0,768; 0,906] |
| Recall con FPR ≤ 5 % | 0,951 | 0,659 |
| Estimadores (early stopping) | 603 | 769 |

## 3. Confirmación (una sola apertura del test)

| Test interno (82 positivos) | Valor | IC 95 % | Criterio |
|---|---|---|---|
| PR-AUC (nulo 0,210) | 0,709 | [0,619; 0,799] | ✅ mejora material |
| ROC-AUC | 0,884 | [0,842; 0,924] | ✅ |
| Recall (umbral 0,6695) | 0,512 | **[0,402; 0,622]** | ❌ límite inferior < 0,50 |
| FPR | 0,068 | [0,040; 0,097] | ✅ |
| Brier | 0,103 frente a 0,166 constante | | ✅ |

Robustez: `REVIEW_REQUIRED` por el mismo criterio de recall. La ablación monetaria de esa ejecución usó `daysSinceLastTransfer` y no es comparable; el script ya está corregido.

## 4. Conclusiones

1. Sin el artefacto de muestreo, la señal conductual on-chain es real pero moderada (PR-AUC de test 0,71, frente a un nulo de 0,21).
2. Es probable que las métricas de v0.6.1 (PR-AUC externo 0,929) estén infladas por el mismo artefacto. v0.6.1 sigue siendo aceptable **solo** en SHADOW con revisión humana, y así consta en la ficha técnica.
3. La caída de validación (0,834) a test (0,709) se explica por el optimismo de validación, donde se eligieron umbral y calibración, y por el corrimiento temporal: el test es agosto–septiembre.
4. No se modificó umbral, configuración ni modelo después de abrir el test.

## 5. Cambios para el ciclo v8 (ya implementados)

- `prepare-risk-set-controls-v5.mjs --activity-anchor random-lookback`: cada control se ancla a un instante aleatorio y determinista de los 90 días previos, en lugar de los 300 segundos previos.
- `evaluate-onchain-robustness.py`: la ablación excluye también las variables neutralizadas del candidato.

## 6. Estado de las particiones

- Test interno de `bdd3ce69…`: **consumido** (ledger).
- Holdout externo v7 (`545a8e75…`): no abierto. No se usará para evaluar; sus casos pueden usarse solo como datos de entrenamiento en ciclos futuros.

## Evidencia

`candidate-freeze-manifest.json`, `training-report-onchain.json`, `internal-test-confirmation.json`, `robustness-report.json` (en esta carpeta), y `governance/data-openings.json`.
