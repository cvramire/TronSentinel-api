# Enriquecimiento on-chain caso-control

El histórico disponible no conserva contrapartes. Para entrenar variables de grafo sin fuga temporal se construye una cohorte adicional:

- casos: wallets añadidas a blacklist durante el período cubierto por la plataforma;
- controles: wallets activas del mismo mes que nunca aparecen en el histórico de blacklist;
- fecha índice del caso: instante on-chain de inclusión;
- fecha índice del control: instante de actividad usado para el emparejamiento;
- ventana predictora: 90 días estrictamente anteriores a la fecha índice.

La descarga utiliza el endpoint oficial de historial TRC-20 por cuenta, limita los contratos a USDT, exige confirmación, pagina mediante `fingerprint`, guarda checkpoints y puede reanudarse.

## Variables de entorno

`APP_TRONGRID_API_KEY` o `TRONGRID_API_KEY`. La clave nunca se escribe en archivos ni argumentos.

## Seguridad metodológica

La transacción de inclusión y cualquier evento posterior quedan fuera de la ventana predictora. Un resultado truncado o con errores deja `trainingSafe=false` y no puede pasar al entrenamiento.
