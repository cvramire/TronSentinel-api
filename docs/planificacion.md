# Planificación del proyecto

**Proyecto:** TronSentinel · **Curso:** Proyecto Integrador en Inteligencia Artificial (UEES) ·
**Docente:** PhD. (c) Gladys Villegas · **Equipo:** Madheline Katerine Torres Hallo y Carlos Vladimir Ramírez Espinoza

## 1. Definición del problema

Las stablecoins en la red TRON (sobre todo USDT TRC-20) mueven grandes volúmenes con comisiones bajas y se usan tanto
para pagos legítimos como para estafas, fraudes y lavado. Tether puede **congelar** una dirección agregándola a su
blacklist, pero esa decisión llega después del daño. Quien va a recibir o enviar fondos no tiene una forma sencilla y
explicable de saber si una wallet **se comporta como las que luego fueron congeladas**.

**Pregunta de IA:** a partir solo del comportamiento on-chain público de los 90 días previos, ¿qué tan parecida es una
wallet a las wallets que después fueron incluidas en la blacklist de Tether?

### Objetivos

| Objetivo | Indicador | Meta | Resultado |
|---|---|---|---|
| General: priorizar wallets TRON para revisión humana con un modelo explicable | Sistema desplegado y usable | API + interfaz públicas | Cumplido (modo SHADOW) |
| Detectar wallets que luego son congeladas | Recall en el umbral (holdout externo) | ≥ 0,50 | 0,798 (IC 0,708–0,865) |
| Pocas falsas alarmas | FPR en el umbral | ≤ 0,10 | 0,037 (IC 0,018–0,075) |
| Superar baselines | PR-AUC vs. dummy y logística | Mayor | 0,929 vs. 0,341 y 0,913 |
| Explicar cada resultado | Factores por wallet | Top-5 contribuciones | Cumplido |
| Validación honesta | Holdout externo de una sola apertura | Sin reutilizar test | Cumplido y auditado |

## 2. Justificación y relevancia

* **Impacto económico:** una transferencia en blockchain es irreversible; una advertencia previa puede evitar pérdidas.
* **Contexto local:** en Ecuador la Ley Orgánica de Prevención de Lavado de Activos (2024) incorpora a los proveedores de
  activos virtuales como sujetos obligados, que necesitan herramientas de debida diligencia basadas en riesgo.
* **Brecha técnica:** las soluciones comerciales de análisis on-chain son costosas y opacas; TronSentinel usa solo datos
  públicos, documenta sus límites y explica cada resultado.
* **Valor académico:** integra todo el ciclo de vida de un proyecto de IA con datos reales: construcción de etiquetas sin
  fuga de información, diseño caso-control, validación externa, optimización, ética y despliegue.

## 3. Alcance

| Incluye | No incluye |
|---|---|
| Wallets TRON con transferencias USDT/TUSD | Otras redes (Ethereum, BTC) u otros tokens |
| Ventana de 90 días previa a la fecha de evaluación | Historial completo de la wallet |
| Un único clasificador (GB de stumps + Platt) | Reglas manuales, ensambles paralelos, LLM |
| Score relativo, probabilidad muestral, recomendación de revisión y factores | Probabilidad absoluta de delito |
| API en Cloud Functions + interfaz web + aplicación local | Bloqueo, congelamiento o acciones automáticas |
| Modo SHADOW con revisión humana | Uso en producción para decisiones adversas |
| Evaluación de wallets individuales | Monitoreo masivo o en tiempo real de la red |
| Datos públicos on-chain | Datos KYC, identidades o información off-chain |

## 4. Cronograma: planificado vs. real

El plan siguió las semanas del curso. Las fechas reales provienen del historial del repositorio, de las carpetas de
datos y de las entregas.

| Fase | Semana planificada | Entregable | Fecha real | Estado / desviación |
|---|---|---|---|---|
| 1. Planificación y definición del problema | S1 | Propuesta, alcance, fuentes de datos | Septiembre 2026 | Cumplido |
| 2. Etiquetas y cohortes | S2 | Historial de la blacklist; primeras cohortes | 27-sep-2026 | Cumplido; las cohortes v1–v4 se descartaron por controles no comparables en el tiempo |
| 3. Diseño risk set y dataset v6 | S2 | Dataset punto en el tiempo con controles emparejados | 28-sep-2026 | **Replanificado:** se pasó de cohortes simples a risk set caso-control (más trabajo, menos fuga) |
| 4. Modelado, robustez y holdout externo | S2–S3 | Modelo v0.6.1, holdout externo de una sola apertura | 28-sep-2026 | Cumplido |
| 5. Despliegue SHADOW (API + interfaz) | S3 | Cloud Function y Hosting | 28/29-sep-2026 | Adelantado respecto del plan |
| 6. Diagnóstico de overfitting / underfitting | S3 | Workshop S3 (versión corregida) | 18-oct-2026 | Corregido tras retroalimentación |
| 7. Impacto social y responsabilidad | S4 | Workshop S4 (93/100; versión corregida) | 06-oct-2026 / 23-oct-2026 | Cumplido y corregido |
| 8. Gobernanza de entrenamiento y ciclo v7 | S4–S5 | Early stopping, bootstrap agrupado, registro de aperturas; candidato v7 | 22/23-oct-2026 | Ciclo v7 cerrado como `FAILED_INTERNAL_TEST` (no se despliega) |
| 9. Optimización y validación en contextos simulados | S5 | Workshop S5, `04_optimizacion.ipynb` | 23-oct-2026 | Cumplido |
| 10. Interfaz final (demo sin clave, Acerca de, exportación) | S5–S6 | Interfaz desplegada | 23-oct-2026 | Cumplido |
| 11. Repositorio, documentación y manual | S6 | README, `docs/`, notebooks 01–05, pruebas | 23-oct-2026 | Cumplido |
| 12. Video pitch y video de preguntas | Última semana | 2 videos | Pendiente | — |

**Principales desviaciones:** (1) el diseño de datos tomó más tiempo del previsto porque los primeros controles no eran
comparables en el tiempo; (2) el diagnóstico de overfitting reveló que 150 árboles no son el punto de convergencia y
motivó la gobernanza de entrenamiento; (3) en octubre se detectó el sesgo de recencia de los controles, que llevó al
ciclo v7 (rechazado) y al rediseño del muestreo para v8.

## 5. Recursos necesarios

| Tipo | Recurso | Uso |
|---|---|---|
| Datos | Blockchain TRON vía TronGrid (clave gratuita con límites de tasa) | Historial de transferencias y eventos de blacklist |
| Datos | Eventos `AddedBlackList` del contrato USDT-TRC20 | Etiquetas fechadas |
| Hardware | MacBook Pro del equipo (desarrollo y entrenamiento); entrenar el modelo toma segundos | Pipeline de datos y modelos |
| Hardware | Almacenamiento local de varios GB para los NDJSON crudos | `TronSentinel-data/` |
| Cloud | Firebase (plan Blaze): Hosting, Cloud Functions 2.ª gen., Firestore, Secret Manager | Despliegue |
| Software | Python 3.13, scikit-learn, pandas, optuna, Jupyter; Node.js 22, TypeScript, Express | Modelado y API |
| Software | Git y GitHub | Versionamiento |
| Personas | 2 integrantes; revisión de la docente | Desarrollo y validación |

## 6. Riesgos identificados y mitigación

| Riesgo | Prob. | Impacto | Mitigación aplicada | Estado |
|---|---|---|---|---|
| Fuga de información (usar datos del futuro o la propia etiqueta) | Alta | Alto | Variables solo con eventos anteriores a la fecha índice; validación automática de nombres prohibidos; partición por grupo | Controlado (0 eventos posteriores) |
| Controles no comparables con los casos | Alta | Alto | Risk set: controles activos en la misma fecha índice | Mitigado; sesgo residual de recencia detectado y corregido para v8 |
| Sobreajuste por pocos positivos | Media | Alto | Stumps, `min_samples_leaf` 20, subsample, CV agrupada, bootstrap agrupado | Controlado (brecha train–val pequeña) |
| Reutilizar el test para elegir el modelo | Media | Alto | Registro de aperturas (`governance/data-openings.json`); holdout externo de una sola apertura | Controlado |
| Límites de tasa de TronGrid (HTTP 429) | Alta | Medio | Reintentos con espera; `--delay-ms` y `--max-retries` | Controlado |
| Historias truncadas (wallets enormes) | Media | Medio | Excluirlas del entrenamiento y responder `NOT_SCORABLE` | Controlado |
| Interpretar el score como acusación | Alta | Alto | Modo SHADOW, lenguaje de "similitud", advertencias de prevalencia, revisión humana | Mitigado en interfaz y docs |
| Exposición de la clave de la API | Media | Medio | Solo se guarda el SHA-256; la clave se entrega en privado; demo sin clave limitada a 5 ejemplos | Controlado |
| Costos de cloud | Baja | Medio | `maxInstances` 1, caché de 6 h en la demo, límite por IP | Controlado |
| Retrasos del cronograma | Media | Medio | Priorizar el pipeline de datos; documentar cada ciclo | Ocurrió en datos; recuperado |
