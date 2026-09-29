# TronSentinel API

Backend académico del proyecto [TronSentinel](https://github.com/cvramire/TronSentinel-api). Utiliza Node.js 22, TypeScript, Express, Firebase Functions de segunda generación y Firestore.

## Estado de este backend

Es una API académica mínima enfocada exclusivamente en scoring de riesgo de wallets en la red TRON. No contiene Telegram, pagos, usuarios, alertas comerciales, ScoreCombinado, reglas determinísticas ni componente bayesiano.

La API utiliza exclusivamente un modelo con estado `CHAMPION` registrado en Firestore. Mientras no exista el dataset punto en el tiempo y no se promueva un modelo, los endpoints de scoring devolverán `MODEL_NOT_AVAILABLE`; no existe fallback hacia un scoring anterior.

El repositorio excluye deliberadamente:

- credenciales y archivos `.env`;
- `.firebaserc` de otros proyectos Firebase;
- dependencias instaladas en `node_modules`;
- código compilado en `lib`;
- frontend y bot;
- cachés y archivos locales del sistema operativo.

## Configuración inicial

1. Proyecto Firebase configurado: `pry-tronsentinel`.
2. La copia local incluye `.firebaserc`; el archivo permanece ignorado por Git para evitar cambios accidentales de destino.
3. Copiar `functions/.env.example` como `functions/.env` solo para desarrollo local.
4. Guardar secretos de despliegue mediante Google Secret Manager.

No se debe apuntar esta copia a otro proyecto Firebase distinto de `pry-tronsentinel`.

## Proyecto Firebase

- Nombre: TronSentinel
- Project ID: `pry-tronsentinel`
- Número de proyecto: `897725969747`
- Plan observado al configurar la base: Blaze

## Endpoints

- `GET /health`
- `GET /v1/model`
- `POST /v1/score/wallet`
- `POST /v1/score/transaction`

Los endpoints bajo `/v1` requieren el encabezado `x-api-key`. La variable `APP_API_KEY_SHA256` debe contener el SHA-256 hexadecimal de la clave, nunca la clave en texto plano.

## Colecciones

- `ts_feature_snapshots`
- `ts_model_registry`
- `ts_model_control`
- `ts_predictions`

Las reglas de Firestore niegan todo acceso desde clientes. El servicio usa Firebase Admin dentro de la función.

## Salvaguarda contra fuga de información

El clasificador rechaza artefactos que declaren variables asociadas con listas negras, OFAC, Tatum, etiquetas o scores anteriores. Las listas externas se reservan para la construcción offline del ground truth.

## Verificación local

```bash
cd functions
npm ci
npm test
```

## Construcción de snapshots

```bash
cd functions
npm run dataset:snapshots -- \
  --input /ruta/events_clean.csv \
  --output-dir /ruta/tronsentinel-snapshots
```

Para una validación rápida puede agregarse `--max-rows 5000`. El resultado incluye CSV, NDJSON para Firestore y un manifiesto con hashes, fechas de corte y variables excluidas por fuga de información.

```bash
npm run dataset:validate -- /ruta/tronsentinel-snapshots
```

No se debe desplegar el scoring hasta construir los snapshots, ejecutar el backtesting temporal y promover explícitamente un modelo campeón.

## Etiquetado histórico

El pipeline de etiquetado cruza los snapshots con eventos externos confirmados y fechados. No utiliza scores anteriores como etiquetas ni convierte automáticamente una revisión actual de Tatum en un evento histórico.

```bash
cd functions
npm run dataset:label -- \
  --snapshots-dir /ruta/tronsentinel-point-in-time-v0.2.0 \
  --labels /ruta/blacklist-label-events.csv \
  --coverage-end 2026-09-30T23:59:59Z \
  --horizon-days 90 \
  --output-dir /ruta/tronsentinel-point-in-time-v0.3.0
```

La especificación completa se encuentra en `docs/LABELING_PROTOCOL.md`. Las filas sin seguimiento futuro completo se censuran; las wallets ya listadas al momento del snapshot se excluyen.

## Frontend de evaluación manual (front/)

`front/evaluador-wallet-tronsentinel.html` es una página estática de una sola vista para evaluar manualmente una wallet TRON contra el modelo, en modo `SHADOW` (sin acciones automáticas). No tiene backend propio: se conecta directamente, desde el navegador, a los endpoints ya desplegados en Firebase Functions:

- `GET /v1/model/shadow` — metadata del modelo activo y el umbral operativo de revisión.
- `POST /v1/score/wallet/shadow/live` — score de riesgo, banda percentil, contribuciones principales de las variables y estado del historial on-chain de 90 días para la wallet consultada.

El usuario ingresa la dirección TRON y una API key (header `x-api-key`); la clave solo se usa en memoria del navegador para esa consulta puntual y no se guarda ni se envía a ningún otro destino.

### Ejecutar localmente

```bash
cd front
python3 -m http.server 8080
```

Luego abrir `http://localhost:8080/evaluador-wallet-tronsentinel.html` en el navegador. Se recomienda servirlo con un servidor HTTP local en vez de abrir el archivo directamente con `file://`, ya que algunos navegadores restringen `fetch` y el acceso al portapapeles bajo ese esquema.
