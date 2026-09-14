"""Export only expert-verified annotations with unchanged, completed dual-human sources."""
import argparse
import json
from pathlib import Path

from contracts import FINAL_STATUSES, annotation_signature, validate_record, validate_human_source
from common import TAXONOMY_VERSION, read_json, valid_id, write_json, write_jsonl
from taxonomy_prompt import LABEL_CODES, MODALITY_ORDER


def collect_final(tasks, annotations_dir, annotators=("A1", "A2"), expert_id="EXPERT"):
    identities = [*annotators, expert_id]
    if len(annotators) != 2 or not all(valid_id(who) for who in identities) or len(set(identities)) != 3:
        raise ValueError('require two distinct annotators and a distinct expert with safe IDs')
    final, excluded = [], []
    root = Path(annotations_dir)
    for task in tasks:
        vid = task["video_id"]
        sources = {who: read_json(root/who/f"{vid}.json") for who in annotators}
        expert = read_json(root/expert_id/f"{vid}.json")
        try:
            for who, source in sources.items():
                validate_human_source(source, task)
                if source.get("annotator") != who or source.get("role") != "annotator":
                    raise ValueError(f"{who} source identity not verified")
                validate_record(source, task)
            if not isinstance(expert,dict) or expert.get("status") not in ("done", "no_risk"):
                raise ValueError("expert verification unresolved or missing")
            if expert.get("annotator") != expert_id or expert.get("role") != "expert":
                raise ValueError("expert identity not verified")
            validate_record(expert, task, expert=True)
            if not str(expert.get("adjudication_note", "")).strip():
                raise ValueError("missing expert adjudication note")
            signatures = {who: annotation_signature(r) for who, r in sources.items()}
            if expert.get("source_signatures") != signatures:
                raise ValueError("human sources changed since expert review")
            final.append({"video_id": vid, "duration_s": task["duration_s"],
                          "taxonomy_version": TAXONOMY_VERSION, "task_version": task["task_version"],
                          "status": expert["status"], "segments": expert["segments"],
                          "expert": expert_id, "expert_signature": annotation_signature(expert),
                          "source_signatures": signatures, "adjudication_note": expert["adjudication_note"],
                          "source_workflows": {who:r.get("review_workflow", "legacy") for who,r in sources.items()},
                          "review_decisions": expert.get("review_decisions", {}),
                          "provenance": task.get("provenance", {})})
        except (ValueError, TypeError, KeyError) as exc:
            excluded.append({"video_id": vid, "reason": str(exc)})
    return final, excluded


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--tasks", required=True)
    parser.add_argument("--annotations", required=True)
    parser.add_argument("--out-dir", required=True, help="new versioned output directory")
    parser.add_argument("--annotators", nargs=2, default=["A1", "A2"])
    parser.add_argument("--expert-id", default="EXPERT")
    args = parser.parse_args()
    target = Path(args.out_dir)
    if target.exists() and any(target.iterdir()):
        parser.error("output directory is not empty; choose a new version to preserve prior exports")
    tasks = read_json(args.tasks)
    if not isinstance(tasks, list) or not tasks:
        parser.error("missing or empty task set")
    try:
        final, excluded = collect_final(tasks, args.annotations, tuple(args.annotators), args.expert_id)
    except ValueError as exc:
        parser.error(str(exc))
    write_jsonl(target/"verified_annotations.jsonl", final)
    report = {"tasks": len(tasks), "verified": len(final), "excluded": excluded,
              "complete": not excluded, "taxonomy_version": TAXONOMY_VERSION,
              "label_order": LABEL_CODES, "modality_order": MODALITY_ORDER,
              "timestamp_unit": "decimal_seconds", "unannotated_gaps_are_not_automatic_negatives": True}
    write_json(target/"export_report.json", report)
    print(json.dumps(report, ensure_ascii=False))
    return 2 if excluded else 0


if __name__ == "__main__":
    raise SystemExit(main())
