"""Human submission contracts and immutable source signatures; standard library only."""
import math

from common import TAXONOMY_VERSION, digest, valid_id
from taxonomy_prompt import LABEL_CODES, MODALITY_ORDER

FINAL_STATUSES = {"done", "no_risk", "needs_expert"}


def task_version(task):
    return digest({k:v for k,v in task.items() if k != "task_version"})


def validate_record(record, task, expert=False):
    if not isinstance(record, dict) or record.get("video_id") != task["video_id"]:
        raise ValueError("unknown or mismatched video_id")
    if record.get("task_version") != task["task_version"]:
        raise ValueError("task version changed; reload and reconcile annotations")
    status = record.get("status")
    workflow = record.get("review_workflow", "legacy")
    if workflow not in ("legacy", "segments_only"):
        raise ValueError("unknown review workflow")
    simplified = workflow == "segments_only"
    if status not in FINAL_STATUSES | {"in_progress"}:
        raise ValueError("invalid video status")
    complete = status in FINAL_STATUSES
    if not isinstance(record.get("whole_video_reviewed", False), bool):
        raise ValueError("whole_video_reviewed must be boolean")
    segments = record.get("segments")
    if not isinstance(segments, list):
        raise ValueError("segments must be a list")
    duration = task.get("duration_s")
    seen = set()
    for seg in segments:
        if not isinstance(seg, dict) or not valid_id(seg.get("segment_id")) or seg["segment_id"] in seen:
            raise ValueError("each segment requires a unique stable segment_id")
        seen.add(seg["segment_id"])
        start, end = seg.get("start_s"), seg.get("end_s")
        if any(isinstance(x, bool) or not isinstance(x, (int,float)) or not math.isfinite(x) for x in (start,end)):
            raise ValueError("nonfinite or nonnumeric segment times")
        if duration is None or not 0 <= start < end <= duration:
            raise ValueError("segment outside video or end <= start")
        for field, allowed in (("labels",LABEL_CODES),("modalities",MODALITY_ORDER)):
            values = seg.get(field)
            if not isinstance(values,list) or any(v not in allowed for v in values) or len(set(values)) != len(values):
                raise ValueError(f"invalid {field}")
            if complete and not values:
                raise ValueError(f"completed segment needs {field}")
        if not isinstance(seg.get("needs_review",False), bool):
            raise ValueError("needs_review must be boolean")
        if complete and not str(seg.get("rationale","")).strip():
            raise ValueError("completed segment needs a rationale")
        if (status in ("done", "no_risk") or (simplified and complete)) and seg.get("needs_review"):
            raise ValueError("verify or remove unconfirmed segments before submitting" if simplified else "unresolved segments require needs_expert")
        if not simplified and expert and status == "done" and "F1" in seg["labels"] and not str(seg.get("verification_note","")).strip():
            raise ValueError("F1 requires a fact-check source/explanation in verification_note")
    decisions = record.get("review_decisions", {})
    if not isinstance(decisions, dict):
        raise ValueError("invalid review decisions")
    review_ids = {r["review_id"] for r in task.get("review_items", [])}
    if set(decisions)-review_ids or any(v not in ("checked", "added", "rejected", "unresolved") for v in decisions.values()):
        raise ValueError("invalid review item decision")
    if complete:
        if not record.get("whole_video_reviewed") and status != "needs_expert":
            raise ValueError("confirm whole-video review before completing")
        if task.get("media_status") != "ok" and status != "needs_expert":
            raise ValueError("missing media cannot be declared reviewed or safe")
        if not simplified and review_ids-set(decisions):
            raise ValueError("all machine review items require a disposition")
        if not simplified and "unresolved" in decisions.values() and status != "needs_expert":
            raise ValueError("unresolved review items require needs_expert")
        if status == "no_risk" and segments:
            raise ValueError("no_risk cannot contain risk segments")
        if status == "done" and not segments:
            raise ValueError("use no_risk when no segments remain")
    return {**record, "taxonomy_version": TAXONOMY_VERSION, "schema": "thvl-anno-2"}


def annotation_signature(record):
    return digest(record) if record is not None else None


def compare_annotations(first, second):
    """Temporal matching by label, with unmatched intervals retained (not a global IAA score)."""
    left = (first or {}).get("segments", [])
    right = (second or {}).get("segments", [])
    pairs, used = [], set()
    for a in left:
        best, best_iou = None, 0.
        for i,b in enumerate(right):
            if i in used or set(a["labels"]) != set(b["labels"]):
                continue
            intersection = max(0., min(a["end_s"],b["end_s"])-max(a["start_s"],b["start_s"]))
            union = max(a["end_s"],b["end_s"])-min(a["start_s"],b["start_s"])
            iou = intersection/union if union else 0.
            if iou > best_iou:
                best, best_iou = i,iou
        if best is None:
            pairs.append({"first": a, "second": None, "temporal_iou": 0.})
        else:
            used.add(best)
            pairs.append({"first": a, "second": right[best], "temporal_iou": round(best_iou,6)})
    pairs.extend({"first":None,"second":b,"temporal_iou":0.} for i,b in enumerate(right) if i not in used)
    return {"first_status":(first or {}).get("status"), "second_status":(second or {}).get("status"), "pairs":pairs}
