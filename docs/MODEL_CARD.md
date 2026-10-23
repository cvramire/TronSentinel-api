# Ficha del modelo — tronsentinel-onchain-riskset-v0.6.1-20260928

Documento fuente completo (con gráficos y diseño): [`Documentacion_Modelo_TronSentinel.pdf`](./Documentacion_Modelo_TronSentinel.pdf).

Modelo: `tronsentinel-onchain-riskset-v0.6.1-20260928` · Artefacto SHADOW: `tronsentinel-wallet-shadow-v0.7.0-20260928`
Autores: Madheline Katerine Torres Hallo, Carlos Vladimir Ramírez Espinoza · Proyecto Integrador en Inteligencia Artificial MIAR0545 · 28 de septiembre de 2026.

## 1. Resumen y alcance

TronSentinel es un modelo supervisado que prioriza wallets de la red TRON para revisión humana. Analiza el comportamiento on-chain observado durante los 90 días anteriores a una fecha de evaluación y produce un score comparativo, una banda percentil y una recomendación operativa.

La unidad evaluada es la **wallet**, no la transacción individual: las transferencias son evidencia histórica usada para construir variables. Todas las variables se calculan antes de la fecha índice; la blacklist nunca entra como predictor.

Pipeline: eventos USDT → ventana de 90 días previos → 38 variables → Gradient Boosting → score + recomendación de revisión.

**Pregunta que responde:** ¿qué tan parecido es el comportamiento reciente de una wallet a los patrones observados antes de inclusiones confirmadas en la blacklist de Tether?

**Qué incluye:**

- Wallets TRON con actividad confirmada en los contratos analizados de USDT.
- Ventanas estrictas de 90 días anteriores a la fecha índice.
- Un único clasificador Gradient Boosting con calibración Platt.
- Explicación mediante contribuciones de variables y revisión humana en modo `SHADOW`.

**Qué no incluye:**

- Scoring de transacciones individuales, reglas heurísticas, Bayes o un ensamble operativo paralelo.
- Bloqueo de wallets, congelamiento de fondos o decisiones automáticas.
- Una probabilidad absoluta de actividad ilícita o una certificación de licitud.

## 2. Diseño del dataset

Dataset de desarrollo: 1.854 filas, 400 casos positivos, 1.454 controles completos, 38 variables on-chain.

**Construcción punto-en-tiempo:** cada caso usa una fecha índice anterior a su inclusión conocida en la blacklist. Para esa misma fecha se seleccionan controles activos y se reconstruyen únicamente eventos previos, de modo que el modelo aprende señales disponibles en el momento de la evaluación y no información del futuro.

| Partición | Filas | Positivas | Controles | Grupos |
|---|---|---|---|---|
| Entrenamiento | 1.294 | 280 | 1.014 | 280 |
| Validación | 278 | 60 | 218 | 60 |
| Test interno | 282 | 60 | 222 | 60 |

**Controles de integridad:**

- Separación cronológica por `matchedCaseId`: ningún grupo cruza entre train, validation y test.
- Cero cruces de direcciones entre casos, controles de desarrollo y holdout externo.
- Cero eventos posteriores a la fecha índice y cero valores no finitos.
- Historias truncadas o censuradas se excluyen del entrenamiento primario y son `NOT_SCORABLE`.
- La pertenencia a blacklist es la etiqueta objetivo; nunca se utiliza como predictor.

**Etiqueta supervisada:** Target 1 = wallet con inclusión futura y fechada en la blacklist de Tether. Target 0 = control activo sin inclusión conocida y con seguimiento suficiente.

## 3. Las 38 variables del modelo

Las variables resumen la actividad de cada wallet dentro de su ventana de 90 días, con la misma semántica en entrenamiento y en evaluación en vivo.

| Familia | Variables | Qué representa |
|---|---|---|
| Actividad | `transferCount`, `transactionCount`, `activeDays`, `activeDayRatio`, `averageDailyTransfers` | Frecuencia y presencia temporal |
| Dirección del flujo | `inboundCount`, `outboundCount`, `inboundRatio`, `outboundRatio` | Entradas y salidas |
| Montos | `totalAmount`, `inboundAmount`, `outboundAmount`, `netFlowAmount`, `meanAmount`, `amountStd`, `amountCv`, `maxAmount` | Volumen y dispersión monetaria |
| Contrapartes | `uniqueCounterparties`, `uniqueInboundCounterparties`, `uniqueOutboundCounterparties`, `repeatedCounterpartyRatio` | Diversidad y repetición |
| Concentración | `topCounterpartyShare`, `counterpartyHhi`, `counterpartyEntropy`, `inboundTopCounterpartyShare`, `outboundTopCounterpartyShare` | Dependencia de contrapartes dominantes |
| Autotransferencias | `selfTransferCount`, `selfTransferRatio` | Movimientos hacia la misma dirección |
| Activos | `usdtTransferCount`, `usdtAmount` | Actividad por token |
| Temporalidad | `meanInterEventSeconds`, `interEventStdSeconds`, `interEventCv`, `burstiness`, `observedSpanDays`, `daysSinceLastTransfer` | Ritmo, ráfagas y recencia |

**Regla anti-leakage:** ninguna variable contiene `blacklist`, `label`, `riskScore`, `riskLevel` ni un score previo. Todas se derivan de eventos confirmados anteriores a `indexAtUtc`.

**Características que más utiliza el modelo final:**

| Variable | Importancia | Interpretación |
|---|---|---|
| `daysSinceLastTransfer` | 49,66 % | Recencia de la última transferencia |
| `meanAmount` | 44,38 % | Monto promedio transferido |
| `repeatedCounterpartyRatio` | 3,60 % | Proporción de contrapartes repetidas |
| `maxAmount` | 1,29 % | Monto máximo observado |
| `inboundCount` | 0,50 % | Cantidad de transferencias entrantes |

## 4. Entrenamiento, calibración y decisión

**Clasificador:** Gradient Boosting de 150 árboles de profundidad 1; cada árbol aprende una corrección pequeña sobre el resultado acumulado, y los pesos de clase compensan la diferencia entre casos positivos y controles.

| Parámetro | Valor | Propósito |
|---|---|---|
| Estimadores | 150 | Combinar correcciones simples |
| Profundidad | 1 | Mantener árboles interpretables y controlar sobreajuste |
| Learning rate | 0,04 | Aprendizaje gradual |
| Min. samples leaf | 20 | Evitar reglas basadas en muy pocos casos |
| Subsample | 0,8 | Introducir variación controlada |
| Seed | 20260927 | Reproducibilidad |

**Calibración Platt:** la salida bruta del ensamble se transforma con una regresión logística de una sola dimensión: `p = sigmoid(a × salida_bruta + b)`. Mejora la correspondencia entre los valores del modelo y las frecuencias observadas en la muestra caso-control.

**Umbral operativo:** seleccionado en validación con un límite máximo de falsos positivos del 5 %, congelado en `0,4288828974` antes de abrir el holdout externo.

**Dos escalas diferentes:** la probabilidad muestral decide si se recomienda revisión; el score 0-100 es un percentil frente a controles y describe posición relativa. Por eso una banda percentil elevada puede quedar por debajo del umbral de revisión.

| Salida | Ejemplo | Interpretación correcta |
|---|---|---|
| Score relativo | 85/100 | Mayor que el 85 % aproximado de los controles de referencia |
| Probabilidad muestral | 7,64 % | Salida calibrada en la muestra caso-control |
| Umbral | 42,89 % | Límite operativo congelado |
| Decisión | No requiere revisión | 7,64 % está por debajo de 42,89 % |

**Aclaraciones posteriores (octubre 2026, diagnóstico corregido de overfitting):**

- 150 estimadores no constituyen convergencia demostrada. Al ampliar el seguimiento a 1.000 estimadores, el log loss de validación sigue bajando después de 150.
- 914 estimadores (mínimo observado del log loss de validación) es un resultado exploratorio, no un parámetro aprobado. Se obtuvo con la misma validación y varía con la semilla; con la regla predefinida de early stopping el punto óptimo oscila entre 516 y 845 en 10 semillas.
- Con la muestra actual (60 positivos en validación y 60 en test) no existe una estrategia de regularización estadísticamente ganadora: los IC bootstrap agrupados de las diferencias pareadas incluyen cero.
- El modelo v0.6.1 continúa en `SHADOW` porque aprobó la gobernanza interna y el holdout externo de una sola apertura, no porque haya ganado una comparación en test.
- Las probabilidades siguen siendo probabilidades de una muestra caso-control.
- El score sigue siendo un percentil relativo frente a controles, no una probabilidad absoluta.
- El subajuste se evalúa contra la prevalencia de cada partición (PR-AUC nulo: 0,2158 en validación, 0,2128 en test), no con un umbral universal de 0,50.
- El test interno de este dataset y el holdout externo ya fueron abiertos y quedan registrados en `governance/data-openings.json`; no pueden reutilizarse para elegir estimadores, profundidad, regularización, umbral ni percentiles. La política de entrenamiento de la próxima versión está en [`TRAINING_GOVERNANCE.md`](./TRAINING_GOVERNANCE.md).

## 5. Validación y desempeño

| Evaluación | ROC AUC | PR AUC | Brier | Recall | FPR |
|---|---|---|---|---|---|
| Test interno | 0,967 | 0,899 | 0,052 | 0,817 | 0,036 |
| Holdout externo | 0,962 | 0,929 | 0,079 | 0,798 | 0,037 |
| Regresión logística (baseline) | 0,895 | 0,712 | 0,135 | 0,600 | 0,054 |
| Prevalencia constante (baseline) | 0,500 | 0,213 | 0,168 | – | – |

**Holdout externo de una sola apertura:** 286 observaciones evaluables, 99 positivas, 187 controles completos, F1 externo de 0,854. Matriz de confusión: TN=180, FP=7, FN=20, TP=79. Trece controles truncados quedaron fuera como no evaluables y un caso positivo sin control completo fue excluido antes del cálculo. El modelo y el umbral permanecieron congelados durante la evaluación.

**Decisión de gobernanza:** `PASSED_EXTERNAL_HOLDOUT` y `APPROVED_FOR_SHADOW_DEPLOYMENT`. El modelo está autorizado para observación y revisión humana, no para decisiones automáticas ni para interpretar su salida como probabilidad absoluta de producción.

## 6. Cómo se explica una evaluación

El modelo exporta la contribución de cada variable para una wallet concreta: una contribución positiva aumenta la salida del clasificador, una negativa la reduce. Estas contribuciones explican el cálculo, pero no demuestran causalidad ni culpabilidad.

Ejemplo real del prototipo:

| Variable | Contribución | Lectura |
|---|---|---|
| `meanAmount` | -1,5170 | El monto promedio redujo considerablemente el score |
| `daysSinceLastTransfer` | +1,2445 | La recencia aumentó considerablemente el score |
| `maxAmount` | -0,3170 | El monto máximo redujo moderadamente el score |
| `repeatedCounterpartyRatio` | +0,2474 | La repetición de contrapartes aumentó ligeramente el score |
| `inboundCount` | +0,0818 | Las entradas produjeron un aumento pequeño |

**Calidad de la evidencia:** la wallet del ejemplo tenía un historial completo, pero solamente dos transferencias; el resultado es evaluable, aunque la evidencia conductual es limitada y debe leerse con cautela.

**Ablaciones:** el modelo depende materialmente de las variables monetarias y de recencia. Sin variables monetarias, el PR AUC de test baja de 0,899 a 0,700. Sin `daysSinceLastTransfer` baja a 0,761; sin ambas familias baja a 0,380.

**Reglas para comunicar el resultado:**

- Decir "score comparativo" o "banda percentil", no "probabilidad de delito".
- Mostrar probabilidad muestral y umbral junto con la decisión de revisión.
- Traducir nombres técnicos de variables a frases comprensibles.
- Informar cuando existe poca actividad, truncamiento o cobertura incompleta.
- Conservar siempre la advertencia de modo `SHADOW` y revisión humana.

## 7. Despliegue, gobierno y limitaciones

**Operación en modo SHADOW:** la API recibe una dirección TRON, consulta TronGrid, reconstruye 90 días de transferencias, calcula las 38 variables y ejecuta el artefacto activo. La respuesta informa score, banda percentil, recomendación y contribuciones. Ningún resultado bloquea wallets ni modifica la blockchain.

| Componente | Versión / política |
|---|---|
| Modelo | `tronsentinel-onchain-riskset-v0.6.1-20260928` |
| Artefacto SHADOW | `tronsentinel-wallet-shadow-v0.7.0-20260928` |
| Feature set | `tron-wallet-onchain-1.0.0` |
| Ventana | 90 días |
| Umbral | `0,4288828973999436` |
| Acciones automáticas | No permitidas |
| Historias truncadas | `NOT_SCORABLE` |

**Limitaciones conocidas:**

- La prevalencia caso-control del dataset no representa la prevalencia real de producción.
- La etiqueta blacklist es un proxy de riesgo confirmado y puede omitir wallets aún no incluidas.
- El modelo cubre la actividad disponible de los contratos analizados; no representa toda la actividad posible en TRON.
- Las variables monetarias y de recencia concentran gran parte de la capacidad predictiva.
- Las wallets con muy poca actividad pueden producir resultados evaluables con evidencia limitada.
- El data drift requiere monitoreo y una futura política formal de reentrenamiento.
- Una versión candidata `v0.7.x`/`v0.8.x` requiere una nueva cohorte temporal externa; el holdout externo de v0.6.1 ya fue consumido.

**Trazabilidad:** dataset, modelo, reportes de entrenamiento, robustez, validación académica y holdout externo están versionados mediante SHA-256. El dataset de desarrollo congelado tiene hash `1039cb723b12f11b7793394cef430d5eea0e97cac6582bf277fa691c86558585`.

**Conclusión:** TronSentinel demuestra que un único clasificador, entrenado con ventanas punto-en-tiempo y evaluado con un holdout externo, puede priorizar wallets TRON para revisión humana con bajo falso positivo. Su salida es una ayuda analítica, no una sentencia automática.

## 8. Reproducibilidad y referencias

**Artefactos principales:**

| Artefacto | Función |
|---|---|
| `onchain-feature-dataset.csv` | Dataset de desarrollo con 1.854 filas y 38 variables |
| `onchain-feature-manifest.json` | Esquema, conteos, splits y hashes |
| `model-challenger-onchain.json` | Clasificador exportado, calibrador y umbrales |
| `training-report-onchain.json` | Métricas por partición e importancia de variables |
| `robustness-report.json` | Bootstrap, ablaciones y estrés exploratorio |
| `academic-validation-report.json` | Baselines y ablaciones complementarias |
| `external-holdout-report.json` | Evaluación externa congelada |
| `wallet-shadow-model-external-approved.json` | Artefacto aprobado para SHADOW |

**Referencias metodológicas:**

- Friedman, J. H. (2001). *Greedy Function Approximation: A Gradient Boosting Machine.* Annals of Statistics, 29(5), 1189-1232.
- Platt, J. (1999). *Probabilistic Outputs for Support Vector Machines and Comparisons to Regularized Likelihood Methods.* Advances in Large Margin Classifiers.
- Brier, G. W. (1950). *Verification of Forecasts Expressed in Terms of Probability.* Monthly Weather Review, 78(1), 1-3.
- Saito, T. y Rehmsmeier, M. (2015). *The Precision-Recall Plot Is More Informative than the ROC Plot When Evaluating Binary Classifiers on Imbalanced Datasets.* PLOS ONE, 10(3).
- scikit-learn developers. `GradientBoostingClassifier`, `LogisticRegression`, calibration and model evaluation documentation.

**Fuentes internas del proyecto:**

- Manifest del dataset de desarrollo risk-set v6.
- Reporte de entrenamiento del modelo v0.6.1.
- Reporte de robustez y validación académica.
- Manifiesto de congelamiento previo al holdout externo.
- Reporte de holdout externo y manifiesto de liberación SHADOW v0.7.

Documento preparado para el Proyecto Integrador en Inteligencia Artificial MIAR0545. Autores: Madheline Katerine Torres Hallo y Carlos Vladimir Ramírez Espinoza.
