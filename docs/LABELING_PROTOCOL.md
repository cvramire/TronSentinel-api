# Protocolo de etiquetado histórico

Versión del dataset etiquetado: `tronsentinel-point-in-time-0.3.0-labeled`

## Objetivo supervisado

Para cada snapshot de una wallet se predice si aparecerá confirmada en una lista negra o de sanciones durante los próximos 90 días. El horizonte puede configurarse, pero debe permanecer idéntico durante entrenamiento, calibración, backtesting y publicación del modelo.

La etiqueta positiva exige un evento `ADD` con fecha efectiva verificable dentro del intervalo `(snapshotAt, snapshotAt + horizonte]`. Los snapshots tomados cuando la wallet ya estaba listada se excluyen.

Una etiqueta negativa sólo se produce cuando todo el horizonte posterior al snapshot se encuentra cubierto por el histórico utilizado. Las filas sin seguimiento completo se censuran y no entran al entrenamiento.

## Formato de evidencia

El archivo puede ser CSV, JSON o NDJSON y debe contener:

| Campo | Descripción |
|---|---|
| `address` | Dirección TRON válida |
| `chain` | `tron-mainnet` |
| `category` | `BLACKLIST` o `SANCTIONED` |
| `action` | `ADD` |
| `dateBasis` | `ONCHAIN_EVENT` u `OFFICIAL_PUBLICATION` |
| `effectiveAtUtc` | Fecha histórica efectiva de inclusión |
| `observedAtUtc` | Fecha en que la evidencia fue obtenida |
| `source` | Fuente verificable |
| `evidenceRef` | Hash, URL, ID o transacción que permite auditarla |
| `confidence` | Número entre 0 y 1 |

Ejemplo de encabezado:

```csv
address,chain,category,action,dateBasis,effectiveAtUtc,observedAtUtc,source,evidenceRef,confidence
```

## Fuentes y reglas

- El histórico de eventos de blacklist de stablecoins en TRON puede utilizarse cuando la acción `ADD` haya sido confirmada mediante la transacción asociada.
- OFAC puede utilizarse para `SANCTIONED` si la fecha de publicación es trazable.
- Un resultado actual de Tatum o TRONSCAN Security sirve como evidencia de revisión, pero no sustituye una fecha histórica de inclusión.
- `NOT_FLAGGED_AT_CHECK_TIME` no significa que una wallet sea limpia permanentemente.
- Los scores y niveles del Wallet Alert anterior no son ground truth y el pipeline los rechaza.

## Ejecución

```bash
cd functions
npm run dataset:label -- \
  --snapshots-dir /ruta/tronsentinel-point-in-time-v0.2.0 \
  --labels /ruta/blacklist-label-events.csv \
  --coverage-end 2026-09-30T23:59:59Z \
  --horizon-days 90 \
  --output-dir /ruta/tronsentinel-point-in-time-v0.3.0
```

`coverage-end` debe ser la última fecha hasta la cual la fuente histórica es completa. No debe confundirse con la fecha en que se descargó el archivo.

Para resolver las acciones del histórico de TRONSCAN por hash de transacción:

```bash
npm run risk:blacklist-actions -- \
  --input /ruta/tronscan-blacklist-history.csv \
  --output /ruta/blacklist-actions \
  --page-size 100 \
  --delay-ms 500
```

El resultado `blacklist-label-events.csv` contiene únicamente eventos `AddedBlackList` confirmados. Si el resumen informa filas `UNMATCHED`, el conjunto todavía no se considera seguro para entrenamiento.

La integración pagina el catálogo completo por ventanas mensuales expresadas en segundos y realiza el cruce local por hash. Esta decisión evita depender del filtro `USDT=1`, que puede responder sin datos aun cuando el catálogo general esté disponible, y respeta el límite de 10.000 posiciones de paginación. El checkpoint se actualiza al completar cada mes para permitir la reanudación.

Las transacciones multisig que no aparecen en el catálogo se resuelven consultando los eventos exactos por hash en TronGrid:

```bash
npm run risk:blacklist-resolve -- \
  --input /ruta/tronscan-blacklist-actions.csv \
  --output /ruta/blacklist-final \
  --delay-ms 500
```

El fallback acepta una acción únicamente cuando el evento pertenece al contrato esperado y la dirección `_user` convertida a Base58Check coincide con la wallet del histórico.

El manifiesto resultante marca `trainingReady=true` sólo si entrenamiento, validación y prueba contienen ejemplos positivos y negativos.

Validación independiente:

```bash
npm run dataset:validate-labels -- /ruta/tronsentinel-point-in-time-v0.3.0
```
