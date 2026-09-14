"""Shared IO, identities and cache contracts (no model dependencies)."""
import hashlib
import json
import math
import os
import re
import tempfile
from pathlib import Path

PIPELINE_VERSION = "thvl-preannotation-3-qwen3-audio"
TAXONOMY_VERSION = "3.0-proposal"
ID_PATTERN = re.compile(r"[A-Za-z0-9_-]+\Z")


def valid_id(value):
    return isinstance(value, str) and bool(ID_PATTERN.fullmatch(value))


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                    allow_nan=False).encode()).hexdigest()


def read_json(path, default=None):
    try:
        return json.loads(Path(path).read_text(encoding="utf-8"), parse_constant=reject_constant)
    except (OSError, ValueError):
        return default


def reject_constant(value):
    raise ValueError(f"Nonfinite JSON constant: {value}")


def atomic_text(path, text):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix="." + path.name, suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def write_json(path, value):
    atomic_text(path, json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")


def write_jsonl(path, values):
    atomic_text(path, "".join(json.dumps(v, ensure_ascii=False, allow_nan=False) + "\n" for v in values))


def load_manifest(path):
    records = [json.loads(line, parse_constant=reject_constant) for line in Path(path).read_text(encoding="utf-8").splitlines()
               if line.strip()]
    seen = set()
    for record in records:
        vid = record.get("video_id")
        if not valid_id(vid) or vid in seen:
            raise ValueError(f"Invalid or duplicate video_id: {vid!r}")
        seen.add(vid)
        if record.get("path") and not Path(record["path"]).is_absolute():
            raise ValueError(f"Manifest paths must be absolute: {vid}")
    if not records:
        raise ValueError("Empty manifest: no annotation tasks")
    return records


def media_identity(record):
    path = record.get("path")
    if not path or not Path(path).is_file():
        return {"video_id": record["video_id"], "path": path, "missing": True}
    stat = Path(path).stat()
    return {"video_id": record["video_id"], "path": str(Path(path).resolve()),
            "size": stat.st_size, "mtime_ns": stat.st_mtime_ns,
            "duration_s": record.get("duration_s")}


def model_identity(model):
    root = Path(model)
    if not root.is_dir():
        return {"reference": model}
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and ".cache" not in path.parts:
            stat = path.stat()
            files.append([str(path.relative_to(root)), stat.st_size, stat.st_mtime_ns])
    return {"path": str(root.resolve()), "file_metadata_digest": digest(files)}


def cache_key(record, stage, config, upstream=None):
    return digest({"version": PIPELINE_VERSION, "stage": stage,
                   "media": media_identity(record), "config": config, "upstream": upstream})


def reusable(data, key, statuses=("ok",)):
    return isinstance(data, dict) and data.get("status") in statuses and data.get("cache_key") == key


def playable(record):
    duration = record.get("duration_s")
    return (record.get("status", "ok") == "ok" and bool(record.get("path"))
            and Path(record["path"]).is_file() and isinstance(duration, (int, float))
            and math.isfinite(duration) and duration > 0)


def transcript_status(data):
    if not isinstance(data, dict):
        return "missing"
    if data.get("audio_contract") and data.get("status") in ("ok", "partial", "no_audio"):
        from audio_schema import validated_audio
        if not validated_audio(data):
            return "error"
    if data.get("status") not in ("ok", "no_audio"):
        return data.get("status", "error")
    if not isinstance(data.get("segments"), list):
        return "error"
    for segment in data["segments"]:
        try:
            start, end = float(segment["start"]), float(segment["end"])
            if not (math.isfinite(start) and math.isfinite(end) and 0 <= start < end
                    and isinstance(segment["text"], str)):
                return "error"
        except (KeyError, TypeError, ValueError):
            return "error"
    return data["status"]
