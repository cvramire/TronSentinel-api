"""Funciones auxiliares compartidas: configuración, rutas, logging y archivos JSON."""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from typing import Any

import yaml

PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_CONFIG = PROJECT_ROOT / "config.yaml"


def get_logger(name: str = "tronsentinel", level: int = logging.INFO) -> logging.Logger:
    """Logger con formato uniforme; evita duplicar handlers si se llama varias veces."""
    logger = logging.getLogger(name)
    if not logger.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s"))
        logger.addHandler(handler)
    logger.setLevel(level)
    return logger


def resolve_path(path: str | Path) -> Path:
    """Convierte una ruta relativa del config en absoluta respecto a la raíz del proyecto."""
    path = Path(path)
    return path if path.is_absolute() else PROJECT_ROOT / path


def load_config(path: str | Path | None = None) -> dict[str, Any]:
    """Lee ``config.yaml`` y valida que existan las secciones obligatorias."""
    config_path = resolve_path(path or DEFAULT_CONFIG)
    try:
        config = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
    except FileNotFoundError as error:
        raise FileNotFoundError(f"No existe el archivo de configuración: {config_path}") from error
    except yaml.YAMLError as error:
        raise ValueError(f"config.yaml no es YAML válido: {error}") from error
    missing = {"project", "data", "model", "artifacts"} - set(config)
    if missing:
        raise ValueError(f"Faltan secciones en config.yaml: {', '.join(sorted(missing))}")
    return config


def save_json(data: Any, path: str | Path) -> Path:
    """Guarda un objeto como JSON legible (UTF-8) creando la carpeta si no existe."""
    target = resolve_path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, ensure_ascii=False, indent=2, default=_to_builtin), encoding="utf-8")
    return target


def sha256_file(path: str | Path) -> str:
    """Hash SHA-256 de un archivo, usado para trazabilidad de datasets y artefactos."""
    digest = hashlib.sha256()
    with open(resolve_path(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _to_builtin(value: Any) -> Any:
    """Convierte tipos de NumPy a tipos nativos para serializar en JSON."""
    if hasattr(value, "item"):
        return value.item()
    if hasattr(value, "tolist"):
        return value.tolist()
    raise TypeError(f"Tipo no serializable: {type(value).__name__}")
