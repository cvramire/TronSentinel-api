# Consideraciones éticas

Este documento resume y actualiza el Workshop S4 *Impacto social y responsabilidad* (versión corregida del 23-oct-2026)
con los resultados de la evaluación final ([`05_evaluacion.ipynb`](../notebooks/05_evaluacion.ipynb)). Todas las cifras
del holdout externo (99 riesgosas, 187 controles) se reportan con IC 95 %.

> **Postura central.** TronSentinel puede generar valor como herramienta de **priorización para revisión humana**, siempre
> que conserve supervisión humana, explicaciones claras, protección de datos y la prohibición de decisiones adversas
> automáticas. Por eso opera en **modo SHADOW**: informa, no actúa.

## 1. Análisis de sesgos

**¿El dataset tiene sesgos?** No contiene variables demográficas, culturales ni geográficas (no hay nombres, país, IP ni
KYC). Sí tiene sesgos de **construcción**:

| Sesgo | Evidencia | Efecto en las predicciones |
|---|---|---|
| **Selección de controles (recencia)** | Los controles se eligieron activos en los 300 s previos a la fecha índice: 67,7 % tiene `daysSinceLastTransfer` < 0,01 días frente a una mediana de 1,24 días en casos; esa variable sola separa las clases con AUC ≈ 0,88 | El modelo aprende en parte el diseño. Las métricas son un **límite superior optimista**; una wallet evaluada justo después de transaccionar recibe un score más bajo. Al retirar la variable (candidato v7) el recall cayó a 0,51 y el candidato se rechazó |
| **Etiqueta proxy** | La blacklist de Tether solo incluye lo que Tether detecta y decide congelar | Wallets riesgosas aún no congeladas cuentan como controles; el modelo hereda los criterios (y omisiones) de Tether |
| **Sesgo por volumen** | El modelo depende de montos altos (`meanAmount`, `maxAmount`) | Detecta peor las riesgosas de bajo volumen (ver sección 2) |
| **Cobertura** | Solo USDT/TUSD en TRON, 90 días | Ignora actividad en otros tokens o redes |
| **Prevalencia artificial** | 22–35 % de riesgosas en los datos vs. ≈ 1 % estimado en la red | La probabilidad muestral sobreestima el riesgo real |

**¿Quiénes podrían ser perjudicados?** (1) Propietarios de wallets legítimas con patrones parecidos a los casos
(montos altos, poca actividad, contrapartes nuevas): comerciantes OTC, personas que reciben un pago grande o mueven
ahorros; (2) usuarios que confían en un "no requiere revisión" sobre una wallet riesgosa de bajo volumen; (3) wallets
que no pueden evaluarse (`NOT_SCORABLE`), que quedan sin señal.

## 2. Equidad y fairness

No usar atributos protegidos evita la discriminación directa, pero **no garantiza equidad**: el volumen, la actividad y la
antigüedad funcionan como proxies del tamaño económico del usuario. Evaluamos el desempeño por subgrupos operativos
(terciles definidos en train, umbral congelado):

| Subgrupo (holdout externo) | Riesgosas / controles | Recall [IC 95 %] | FPR |
|---|---:|---|---:|
| Volumen bajo (≤ 29 254 USDT) | 19 / 79 | **0,37 [0,19–0,59]** | 0,0 % |
| Volumen medio | 38 / 58 | 0,92 [0,79–0,97] | 6,9 % |
| Volumen alto (> 611 105 USDT) | 42 / 50 | 0,88 [0,75–0,95] | 6,0 % |
| **Global** | 99 / 187 | 0,80 [0,71–0,87] | 3,7 % |

El límite superior del recall en bajo volumen (0,59) queda por debajo del límite inferior global (0,71): la diferencia es
real. A la vez, casi todas las falsas alarmas recaen en wallets de volumen medio y alto. El análisis S4 por actividad y
antigüedad observable no mostró diferencias concluyentes (IC solapados).

**Estrategias implementadas:** pesos balanceados por clase; auditoría de subgrupos como criterio de cada ciclo
(acción si una banda con ≥ 15 casos queda con su límite superior de recall bajo el límite inferior global, o con FPR
> 10 %); un ejemplo real de falso negativo de bajo volumen en la interfaz y la advertencia en "Acerca del modelo";
controles *random-lookback* y variables no monetarias en el ciclo v8. No calculamos métricas demográficas porque
requerirían recolectar datos personales sin base legal.

## 3. Privacidad

* **Datos usados:** direcciones TRON y transferencias públicas. Son **seudónimas**, no anónimas: pueden vincularse a una
  persona si se cruzan con datos KYC de un exchange, IP o redes sociales.
* **Datos que no usamos:** nombres, documentos, correos, IP, ubicación ni ningún dato off-chain.
* **Protección en el sistema:**
  * la API registra solo dirección evaluada, versión del modelo, resultado y fecha (`ts_predictions`), nunca la identidad
    de quien consulta;
  * Firestore niega todo acceso desde clientes; solo la función (Admin SDK) lee y escribe;
  * la clave de acceso se guarda como hash SHA-256 y los secretos en Secret Manager; la clave no está en el repositorio;
  * la interfaz no guarda la clave ni el historial (el historial de la sesión vive en memoria y se pierde al cerrar);
  * la demo pública solo evalúa 5 wallets fijas, de modo que no sirve para perfilar direcciones arbitrarias.
* **Cumplimiento:**

| Marco | Aplicación | Estado |
|---|---|---|
| LOPDP Ecuador (R.O. Quinto Suplemento 459, 26 de mayo de 2021) y su Reglamento | Aplica si una dirección o un log permiten identificar a una persona; incluye el derecho a no ser objeto de decisiones basadas únicamente en tratamiento automatizado | Diseño alineado (minimización, SHADOW sin decisiones automáticas, revisión humana de cada alerta); formalización pendiente antes de producción |
| Norma SPDP para IA, Res. SPDP-SPD-2026-0009-R (R.O. No. 240, 10 de marzo de 2026), reformada por la Res. SPDP-SPD-2026-0037-R (9 de septiembre de 2026) | Gestión de riesgos, evaluación de impacto y transparencia. La reforma alcanza a los encargados con "acceso, visibilidad o control efectivo" y obliga a proveedores y desarrolladores a informar al responsable sobre funcionamiento, limitaciones, riesgos y controles | Model card y limitaciones publicadas, con intervalos de confianza, prevalencia y resultados por subgrupo; evaluación de impacto pendiente |
| Norma técnica de vulneraciones, Res. SPDP-SPD-2026-0040-R (9 de septiembre de 2026) | Regula la notificación de vulneraciones de seguridad de datos personales mediante el sistema SISPDP | Plan de incidentes definido; alineamos sus plazos con esta norma antes de cualquier producción |
| Ley Orgánica de Prevención de Lavado de Activos (R.O. Cuarto Suplemento 610, 29 de julio de 2024) | Define activo virtual y proveedor de servicios de activos virtuales (art. 4, lit. a y z), los clasifica como sujetos obligados (art. 26) y exige debida diligencia basada en riesgos (arts. 41 a 43) y reporte mensual de operaciones iguales o superiores a USD 10.000 (art. 58). Los arts. 31 y 57 tienen nota de derogatoria en el texto consolidado de la UAFE y su vigencia debe confirmarse | TronSentinel no es sujeto obligado; puede ser un insumo del enfoque basado en riesgos de un integrador, nunca un sustituto de su debida diligencia ni la decisión de un reporte de operación sospechosa |
| Régimen de criptoactivos en Ecuador | Los criptoactivos no son moneda de curso legal ni medio de pago autorizado por la Junta de Política y Regulación Monetaria; el Banco Central (comunicado del 12 de agosto de 2024) cita el art. 98 del COMF. En octubre de 2026 la Asamblea tramita un proyecto para licenciar exchanges | Uso informativo: no ofrecemos pagos ni custodia; reevaluaremos si se aprueba un régimen de licencias |
| GDPR / CCPA | Solo si se ofrecen servicios a residentes de la UE / California | No aplica en el alcance actual; reevaluar antes de hacerlo |
| EU AI Act | Según mercado y propósito | No clasificado como alto riesgo en el uso previsto |

Como la blockchain es inmutable, la protección se concentra en los datos off-chain que sí controlamos

Esta evaluación es académica y no sustituye la asesoría jurídica. Antes de cualquier producción haremos una revisión legal del caso de uso, en especial sobre la vigencia de los arts. 31 y 57 de la ley de lavado de activos.

## 4. Transparencia y explicabilidad

* **Modelo interpretable por diseño:** cada árbol usa una sola variable, así que la contribución de cada variable al
  logit es **exacta** y se muestra en la interfaz ("Qué factores influyeron", barras naranjas suben el riesgo, azules lo
  bajan). No se necesitan SHAP ni LIME, que serían aproximaciones de algo que aquí se calcula exactamente; la suma de
  contribuciones reproduce el logit (verificado en `tests/test_model.py`).
* **Lenguaje para no expertos:** las variables se traducen ("Monto promedio por transferencia"); cada resultado incluye
  "Cómo leerlo", la diferencia entre score relativo y probabilidad muestral, y la advertencia de prevalencia.
* **Transparencia del sistema:** sección "Acerca del modelo" con métricas e IC, limitaciones y usos prohibidos; ficha
  técnica en vivo desde la API; [`MODEL_CARD.md`](MODEL_CARD.md) público; versiones y hashes de dataset y modelo.
* **Límite de la explicación:** una contribución explica el cálculo, no prueba causalidad ni culpabilidad.

## 5. Impacto social

| | Detalle |
|---|---|
| **Impactos positivos** | Prevención temprana de pérdidas antes de una transferencia irreversible (recall 0,80); mejor uso del tiempo de analistas (ordena casos); consistencia y auditabilidad (mismo vector → mismo resultado, artefacto congelado); educación sobre riesgo digital con explicaciones concretas |
| **Impactos negativos posibles** | Falsas alarmas que dañan la reputación de un propietario legítimo; falsa sensación de seguridad ante un "no requiere revisión"; uso del score como veto automático por un integrador; reidentificación si se cruza con KYC |
| **Quiénes se benefician** | Usuarios que van a transaccionar, analistas de riesgo y cumplimiento, fintechs y proveedores cripto, el ecosistema TRON |
| **Quiénes podrían ser perjudicados** | Propietarios de wallets legítimas con perfil atípico; usuarios de wallets riesgosas de bajo volumen no detectadas; personas con menos capacidad de apelar |

**Efecto de la prevalencia real** (recall 0,798 y FPR 3,74 % fijos):

| Prevalencia real | Precisión esperada | Alertas falsas por cada verdadera |
|---:|---:|---:|
| 5 % | 52,9 % | 0,9 |
| 2 % | 30,3 % | 2,3 |
| 1 % | 17,7 % | 4,6 |
| 0,1 % | 2,1 % | 46,9 |

Con 1 % de wallets riesgosas, ~82 de cada 100 alertas serían falsas. Por eso **la alerta solo ordena la revisión humana**.

### Matriz de riesgos priorizada

Diferenciamos cada riesgo por su severidad (daño si ocurre) y su probabilidad (en el uso previsto), con una escala explícita:

| Nivel | Severidad (daño si ocurre) | Probabilidad (en el uso previsto) |
|---|---|---|
| Alta | Daño económico irreversible o afectación de derechos de una persona (pérdida de fondos, exclusión, exposición de identidad). | Medida en nuestros datos con frecuencia ≥ 10 % de los casos relevantes, o inevitable con la prevalencia real. |
| Media | Daño reversible mediante revisión o apelación (revisión innecesaria, demora, molestia reputacional corregible). | Frecuencia medida entre 1 % y 10 %, o requiere que falle un solo control. |
| Baja | Molestia operativa sin efecto sobre derechos ni fondos. | Menor al 1 %, o requiere que fallen dos o más controles independientes (por ejemplo SHADOW, contrato y revisión humana). |

| Riesgo | Evidencia | Sev. | Prob. | Afectados |
|---|---|---|---|---|
| Sesgo de representación y proxies | Recall de 0,37 en bajo volumen; la recencia separa casos de controles por el diseño del muestreo. | Alta | Alta | Wallets de bajo volumen y perfiles atípicos |
| Daño por error de clasificación | Con prevalencia de 1 %, cerca del 82 % de las alertas serían falsas. | Alta | Media | Propietarios, usuarios y analistas |
| Privacidad y reidentificación | No almacenamos identidad; el riesgo aparece al combinar la dirección con datos KYC del integrador. | Alta | Baja | Titulares identificables |
| Opacidad y mala interpretación | `productionProbabilityReady=false`; la precisión muestral (0,92) cae a cerca de 0,18 con prevalencia de 1 %. | Media | Alta | Usuarios no técnicos y decisores |
| Pérdida de autonomía | Colores y etiquetas pueden generar autoridad aparente; mitigado por SHADOW y motivo humano obligatorio. | Media | Media | Usuarios y analistas |
| Seguridad, drift y disponibilidad | Dependencia de TronGrid; 6,5 % de NOT_SCORABLE en validación como línea base. | Media | Media | Todos los usuarios |
| Responsabilidad difusa | Equipo de dos personas con roles definidos (sección 6); falta formalizar con integradores. | Media | Baja | Personas afectadas y la organización |

Priorizamos la auditoría por subgrupos (sección 2) y los criterios de pausa (sección 6) según estos niveles.

## 6. Responsabilidad

**¿Quién responde si el modelo falla?** El equipo responde por la calidad técnica, la documentación y las limitaciones
declaradas; la organización que integre el score responde por las decisiones que tome con él. El sistema no toma
decisiones: toda acción adversa requiere un analista humano que registre su motivo.

| Rol | Responsabilidad |
|---|---|
| Product Owner | Usos permitidos, umbrales de daño, aprobación de cambios |
| Data scientist | Calidad del dataset, validación con IC, auditoría de subgrupos, drift, model card |
| Backend / MLOps | Paridad de variables, versionado, disponibilidad y rollback |
| Seguridad y privacidad | Accesos, secretos, retención, respuesta a brechas |
| Analista humano | Contrastar evidencia y justificar cada acción |

**Mecanismos de accountability ya implementados:** artefacto congelado con hash SHA-256; registro de aperturas de
particiones de prueba (`governance/data-openings.json`); evidencias por ciclo (`governance/cycles/`); bitácora de
predicciones con versión del modelo; pruebas automáticas de paridad entrenamiento ↔ producción.

**Plan de monitoreo y actualización:**

| Señal | Frecuencia | Umbral de pausa / acción |
|---|---|---|
| FPR observado en revisiones humanas | Mensual | > 7,5 % con ≥ 100 controles revisados, o > 10 % → volver a SHADOW estricto y recalibrar |
| Recall observado (wallets luego congeladas) | Trimestral | < 0,70 con ≥ 30 casos → advertencia general y revisión |
| Drift (PSI) en las 5 variables principales | Mensual | > 0,25 en una o > 0,10 en tres → investigación ≤ 5 días hábiles |
| Tasa de `NOT_SCORABLE` | Mensual | > 15 % (línea base 6,5 %) → revisar proveedor |
| Uso automatizado del score para bloquear | Continuo | 1 caso confirmado → revocar la clave del integrador |
| Reentrenamiento | Trimestral | Nuevo ciclo con la política de [`TRAINING_GOVERNANCE.md`](TRAINING_GOVERNANCE.md) |

SLA de apelación propuestos: acuse ≤ 2 días hábiles, suspensión de la decisión apelada ≤ 24 h, resolución ≤ 15 días hábiles.

## 7. Uso dual y mal uso

| Mal uso posible | Salvaguarda |
|---|---|
| Bloquear, congelar o negar servicio automáticamente con el score | Modo SHADOW (`automaticActionsAllowed = false`); prohibición explícita en la interfaz, el README y el model card; revocación de la clave |
| Acusar públicamente a una persona | Lenguaje de "similitud", no de culpabilidad; advertencias en cada resultado |
| Perfilar masivamente direcciones o vigilar a personas | API con clave; demo pública limitada a 5 ejemplos fijos y 30 consultas / 10 min por IP; `maxInstances` 1 |
| **Evasión:** un actor malicioso usa el score para ajustar su comportamiento hasta parecer legítimo | La interfaz muestra solo las 5 contribuciones principales. El artefacto completo es público en este repositorio por su carácter académico; en un despliegue real no debería publicarse. El Workshop S5 midió que fraccionar en 5 transferencias evade ~23 % de las detecciones → variables robustas al fraccionamiento en v8 |
| Interpretar la probabilidad muestral como riesgo absoluto | Se rotula "probabilidad muestral"; tabla de prevalencias en "Acerca del modelo" |

## 8. Limitaciones reconocidas

**No usar TronSentinel para:**

* bloquear, congelar o rechazar fondos o clientes de forma automática;
* afirmar que una persona cometió un delito o reemplazar una investigación;
* sustituir la debida diligencia KYC/AML de un sujeto obligado;
* evaluar exchanges, custodios o servicios de muy alto volumen (sus historias se truncan → `NOT_SCORABLE`);
* tomar decisiones sobre wallets con poca actividad o bajo volumen sin evidencia adicional.

**Advertencias que deben darse a los usuarios** (todas visibles en la interfaz):

1. El score es un percentil relativo frente a controles, no una probabilidad de delito.
2. Con prevalencia realista la mayoría de alertas son falsas: toda alerta requiere revisión humana.
3. "No requiere revisión" no significa "segura", sobre todo en wallets de bajo volumen.
4. Las métricas están infladas por el sesgo de recencia del muestreo; léanse como límite superior.

**Casos límite donde el modelo no es confiable:**

| Caso | Comportamiento |
|---|---|
| Wallet riesgosa de bajo volumen | Recall 0,37: probablemente no la detecta |
| Wallet que acaba de transaccionar | Score tendencialmente más bajo (sesgo de recencia) |
| Transferencias fraccionadas a propósito | Pierde ~23 % de detecciones con 5 fragmentos |
| Variables faltantes o corruptas | No imputa: responde `NOT_SCORABLE` |
| Historia truncada o sin actividad | `NOT_SCORABLE`, sin score |
| Patrones nuevos posteriores a junio de 2026 | Sin garantía; requiere monitoreo de drift y reentrenamiento |

## Compromiso

Los autores nos comprometemos a reportar siempre las métricas con su incertidumbre y la precisión esperada a una
prevalencia declarada, a mantener la supervisión humana y la prohibición de decisiones adversas automáticas, a auditar
trimestralmente el desempeño por subgrupos y el drift, y a priorizar el bienestar de las personas afectadas sobre las
métricas o la velocidad de lanzamiento.

## Referencias

1. Asamblea Nacional del Ecuador. (2021, 26 de mayo). *Ley Orgánica de Protección de Datos Personales*. Registro Oficial, Quinto Suplemento No. 459.
2. Asamblea Nacional del Ecuador. (2024, 29 de julio). *Ley Orgánica de Prevención, Detección y Combate del Delito de Lavado de Activos y de la Financiación de Otros Delitos*. Registro Oficial, Cuarto Suplemento No. 610 (texto consolidado con reformas a octubre de 2025). https://www.uafe.gob.ec/wp-content/uploads/2025/10/A1-LEY-LAVADO_-OCTUBRE_-2025.pdf
3. Banco Central del Ecuador. (2024, 12 de agosto). *Comunicado sobre el uso de criptoactivos como medio de pago*. https://dplnews.com/?p=245377
4. Mitchell, M., Wu, S., Zaldivar, A., Barnes, P., Vasserman, L., Hutchinson, B., Spitzer, E., Raji, I. D., & Gebru, T. (2019). Model cards for model reporting. *Proceedings of the Conference on Fairness, Accountability, and Transparency (FAT\* '19)*.
5. National Institute of Standards and Technology. (2023). *Artificial Intelligence Risk Management Framework (AI RMF 1.0)* (NIST AI 100-1). https://doi.org/10.6028/NIST.AI.100-1
6. OECD. (s. f.). *Recommendation of the Council on Artificial Intelligence*. https://oecd.ai/en/ai-principles
7. Superintendencia de Protección de Datos Personales. (2026a). *Norma General para la Garantía del Derecho de Protección de Datos Personales en el Uso de Sistemas de Inteligencia Artificial* (Res. SPDP-SPD-2026-0009-R). Registro Oficial No. 240, 10 de marzo de 2026.
8. Superintendencia de Protección de Datos Personales. (2026b, 9 de septiembre). *Reforma a la Norma General… en el Uso de Sistemas de Inteligencia Artificial* (Res. SPDP-SPD-2026-0037-R). https://spdp.gob.ec/resoluciones2/
9. Superintendencia de Protección de Datos Personales. (2026c, 9 de septiembre). *Norma Técnica de Notificaciones de Vulneraciones de la Seguridad de los Datos Personales* (Res. SPDP-SPD-2026-0040-R). https://spdp.gob.ec/resoluciones2/
