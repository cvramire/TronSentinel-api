# Feature set punto en el tiempo

Versión: `tron-wallet-behavior-2.0.0`

## Unidad de observación

Cada fila representa una wallet TRON observada al procesar un evento histórico registrado. El snapshot incluye el evento que origina la observación y todos los eventos anteriores de esa wallet. Nunca utiliza eventos posteriores.

## Ventanas temporales

Las variables se calculan sobre ventanas móviles de 1, 7, 30 y 90 días terminadas en `snapshotAtMs`.

| Grupo | Variables |
|---|---|
| Antigüedad | `walletAgeDays` |
| Actividad | `eventCount1d`, `eventCount7d`, `eventCount30d`, `eventCount90d` |
| Diversidad temporal | `activeDays30d`, `activeDays90d` |
| Transacciones | `uniqueTxCount7d`, `uniqueTxCount30d`, `uniqueTxCount90d` |
| Volumen | `amountSum1d`, `amountSum7d`, `amountSum30d`, `amountSum90d` |
| Magnitud | `amountMax30d`, `amountMax90d`, `amountAverage30d`, `amountAverage90d` |
| Patrones | conteos de `new_whale`, `accumulation` y `distribution` en 30 y 90 días |
| Intensidad | `patternTxCountSum30d`, `patternTxCountSum90d`, eventos por día y velocidad de volumen |
| Proporciones | ratios por tipo y `recentToLongVolumeRatio` |

## Campos excluidos

Los siguientes campos del sistema anterior se conservan únicamente para auditoría del sistema anterior y nunca se incorporan al vector del modelo:

- `legacy_risk_score_raw`
- `legacy_risk_score_capped_100`
- `legacy_risk_level`
- `label_status`
- `target_blacklisted_future`
- resultados de Tatum;
- pertenencia a listas OFAC o Tether;
- direcciones y hashes como variables predictoras.

La dirección, el hash y el bloque se conservan como identificadores de trazabilidad, fuera de `features`.

## División del dataset

La división es cronológica global:

- 70 % para entrenamiento;
- 15 % para validación y calibración;
- 15 % para backtesting final.

No se utiliza partición aleatoria. Las fechas de corte quedan registradas en `dataset_manifest.json`.

## Estado de las etiquetas

Los snapshots generados en esta etapa se marcan como `UNLABELED_BLACKLIST_OUTCOME`. No están listos para entrenamiento supervisado hasta cruzarlos con un histórico de listas negras que incluya la fecha conocida o publicada de cada etiqueta.
