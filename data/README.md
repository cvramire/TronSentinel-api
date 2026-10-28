# Datos de TronSentinel

## Fuente y licencia

| Elemento | Fuente | Licencia / condiciones |
|---|---|---|
| Transferencias USDT y TUSD en TRON | Blockchain pública TRON, consultada con la API de [TronGrid](https://www.trongrid.io/) | Datos públicos on-chain; el uso de la API está sujeto a los términos de TronGrid |
| Etiqueta (inclusión en blacklist) | Eventos `AddedBlackList` del contrato USDT-TRC20 (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) emitidos por Tether | Datos públicos on-chain |
| Dataset procesado (`processed/`) | Construido por el equipo con los scripts de `functions/scripts/` | Se publica con el repositorio (licencia MIT) con fines académicos |

Las direcciones TRON son seudónimas. El dataset no contiene nombres, correos, IP ni datos KYC; ver
[`docs/consideraciones_eticas.md`](../docs/consideraciones_eticas.md#3-privacidad).

## Estructura

```
data/
├── raw/          # Datos crudos: NO se versionan (ver raw/README.md)
├── processed/
│   ├── development_dataset_v6.csv     # 1 854 filas · train / validation / test
│   ├── development_manifest_v6.json   # esquema, conteos, hashes y controles de integridad
│   └── external_holdout_v6.csv        # 286 filas · holdout externo (abierto una sola vez)
└── README.md
```

## Diseño: risk set caso-control punto en el tiempo

* **Unidad:** una wallet evaluada en una fecha índice `indexAtUtc`.
* **Caso (`target = 1`):** wallet incluida después en la blacklist de Tether; la fecha índice es anterior a la inclusión.
* **Control (`target = 0`):** wallet activa en la misma fecha índice, sin inclusión conocida y con seguimiento suficiente.
* **Grupo (`matchedCaseId`):** un caso y sus 2–4 controles. Nunca se separan entre particiones.
* **Ventana:** 90 días previos a la fecha índice; ningún evento posterior entra en las variables.

| Partición | Filas | Riesgosas | Controles | Prevalencia | Fechas índice |
|---|---:|---:|---:|---:|---|
| train | 1 294 | 280 | 1 014 | 21,6 % | 16-mar-2026 → 04-may-2026 |
| validation | 278 | 60 | 218 | 21,6 % | 04-may-2026 → 14-may-2026 |
| test (interno) | 282 | 60 | 222 | 21,3 % | 14-may-2026 → 09-jun-2026 |
| external_holdout | 286 | 99 | 187 | 34,6 % | 25-may-2026 → 09-jun-2026 (wallets distintas) |

Hash SHA-256 del dataset de desarrollo: `1039cb723b12f11b7793394cef430d5eea0e97cac6582bf277fa691c86558585`.

> **Regla de gobernanza.** El test interno y el holdout externo ya fueron abiertos y están registrados en
> `governance/data-openings.json`. No deben usarse para elegir hiperparámetros, umbral ni variables.

## Diccionario de datos

### Metadatos (no son variables del modelo)

| Columna | Tipo | Descripción |
|---|---|---|
| `cohortId` | texto | Identificador de la fila |
| `matchedCaseId` | texto | Grupo caso + controles |
| `address` | texto | Dirección TRON Base58 (34 caracteres, empieza con `T`) |
| `indexAtUtc` | fecha ISO | Fecha de evaluación (corte de la ventana) |
| `datasetSplit` | texto | `train`, `validation`, `test` o `external_holdout` |
| `target` | 0/1 | 1 = incluida después en la blacklist de Tether |

### Las 38 variables (ventana de 90 días)

| Familia | Variable | Descripción |
|---|---|---|
| Actividad | `transferCount` | Transferencias USDT/TUSD observadas |
| | `transactionCount` | Transacciones distintas que contienen esas transferencias |
| | `activeDays` | Días con al menos una transferencia |
| | `activeDayRatio` | `activeDays / 90` |
| | `averageDailyTransfers` | `transferCount / 90` |
| Dirección del flujo | `inboundCount`, `outboundCount` | Transferencias recibidas / enviadas |
| | `inboundRatio`, `outboundRatio` | Proporción de entradas / salidas |
| Montos (USDT) | `totalAmount` | Suma de montos (entradas + salidas) |
| | `inboundAmount`, `outboundAmount` | Montos recibidos / enviados |
| | `netFlowAmount` | Entradas − salidas (puede ser negativo) |
| | `meanAmount`, `maxAmount` | Monto promedio y máximo por transferencia |
| | `amountStd`, `amountCv` | Desviación estándar y coeficiente de variación de montos |
| Contrapartes | `uniqueCounterparties` | Direcciones distintas con las que interactuó |
| | `uniqueInboundCounterparties`, `uniqueOutboundCounterparties` | Remitentes / destinatarios distintos |
| | `repeatedCounterpartyRatio` | (transferencias − contrapartes únicas) / transferencias: cuánto se repiten las contrapartes |
| Concentración | `topCounterpartyShare` | Participación de la contraparte principal |
| | `counterpartyHhi` | Índice Herfindahl-Hirschman de contrapartes |
| | `counterpartyEntropy` | Entropía de la distribución de contrapartes |
| | `inboundTopCounterpartyShare`, `outboundTopCounterpartyShare` | Ídem, por dirección |
| Autotransferencias | `selfTransferCount`, `selfTransferRatio` | Transferencias a la misma dirección |
| Activos | `usdtTransferCount`, `tusdTransferCount` | Transferencias por token |
| | `usdtAmount`, `tusdAmount` | Montos por token |
| Temporalidad | `meanInterEventSeconds`, `interEventStdSeconds`, `interEventCv` | Tiempo entre transferencias |
| | `burstiness` | (σ − μ)/(σ + μ) del tiempo entre eventos, en [−1, 1] |
| | `observedSpanDays` | Días entre la primera y la última transferencia de la ventana |
| | `daysSinceLastTransfer` | Días entre la última transferencia y la fecha índice (90 si no hay transferencias) |

Las fórmulas son idénticas en el entrenamiento (`functions/scripts/build-onchain-features.mjs`) y en la API en vivo
(`functions/src/risk/onchain-features.ts`).

## Calidad de los datos

| Control | Resultado |
|---|---|
| Valores faltantes o no finitos | 0 |
| Filas duplicadas (wallet + fecha) | 0 |
| Grupos que cruzan particiones | 0 |
| Wallets que son caso y control | 0 |
| Wallets compartidas desarrollo ↔ holdout | 0 |
| Eventos posteriores a la fecha índice | 0 |
| Variables con nombre de etiqueta (`blacklist`, `label`, `riskScore`…) | 0 |

`src/data_processing.validate_dataset()` repite estos controles cada vez que se carga un CSV.

## Limitaciones conocidas

* La prevalencia del dataset (22–35 %) es la del diseño caso-control, no la de la red.
* Los controles se eligieron activos en los 300 s previos a la fecha índice, lo que hace que `daysSinceLastTransfer`
  sea ≈ 0 para ellos por construcción (sesgo documentado en `docs/MODEL_CARD.md`).
* `tusdTransferCount` y `tusdAmount` son constantes (cero) en train.
* La blacklist es un proxy de riesgo confirmado: puede omitir wallets riesgosas aún no incluidas.
