#!/usr/bin/env python3
"""Local annotation service: versioned drafts, validated submissions and expert adjudication."""
import argparse
import base64
import gzip
import hashlib
import hmac
import json
import mimetypes
import os
import re
import threading
import time
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from contracts import FINAL_STATUSES, annotation_signature, compare_annotations, validate_record
from common import media_identity, read_json, valid_id, write_json

HERE = str(Path(__file__).resolve().parent)
WRITE_LOCK = threading.Lock()
PROXY_INDEX = None
STATIC = {"annotate.html", "annotate.css", "app.js", "editor.js", "player.js", "autosave.js", "instructions.md", "开始标注.md", "tasks.json"}
VIDEO_TYPES = {".mp4":"video/mp4", ".mov":"video/quicktime", ".webm":"video/webm"}


class ConflictError(ValueError):
    pass


def load_media_map():
    media = read_json(Path(HERE)/"media_map.json", {})
    for vid, proxy in read_json(PROXY_INDEX, {}).items() if PROXY_INDEX else []:
        if vid not in media or proxy.get('status') != 'ok':
            continue
        source = proxy.get('source_identity', {})
        # A proxy cannot replace different or modified original media.
        current = media_identity({'video_id':vid,'path':media[vid], 'duration_s':source.get('duration_s')})
        if source != current or not Path(proxy.get('path','')).is_file():
            continue
        if proxy.get('proxy_identity') != media_identity({'video_id':vid,'path':proxy['path']}):
            continue
        media[vid] = proxy['path']
    return media


def tasks_by_id():
    tasks = read_json(Path(HERE)/"tasks.json", [])
    return {t["video_id"]:t for t in tasks}


def annotation_path(who, vid):
    if not valid_id(who) or not valid_id(vid):
        raise ValueError("invalid annotator/video ID")
    return Path(HERE)/"annotations"/who/f"{vid}.json"


def load_annotation(who, vid):
    path = annotation_path(who,vid)
    if path.exists():
        data = read_json(path)
        if not isinstance(data,dict):
            raise ValueError("saved annotation is unreadable; restore history before editing")
        return data
    return None


def expert_context(vid, annotators):
    originals = {who:load_annotation(who,vid) for who in annotators}
    return {"annotations":originals,
            "source_signatures":{who:annotation_signature(r) for who,r in originals.items()},
            "comparison":compare_annotations(*originals.values())}


def save_annotation(who, record, expected_revision, annotators=("A1","A2"), expert_id="EXPERT"):
    if who not in (*annotators, expert_id):
        raise ValueError("unknown annotator")
    vid = record.get("video_id") if isinstance(record,dict) else None
    if not valid_id(vid) or vid not in tasks_by_id():
        raise ValueError("unregistered video")
    task = tasks_by_id()[vid]
    expert = who == expert_id
    validated = validate_record(record, task, expert)
    with WRITE_LOCK:
        old = load_annotation(who,vid)
        revision = old.get("revision",0) if old else 0
        if expected_revision != revision:
            raise ConflictError("annotation changed in another tab; reload and reconcile")
        if expert:
            context = expert_context(vid,annotators)
            if record.get("source_signatures") != context["source_signatures"]:
                raise ConflictError("human sources changed; reload expert comparison")
            if record["status"] in ("done","no_risk"):
                for source in context["annotations"].values():
                    if not source or source.get("status") not in FINAL_STATUSES:
                        raise ValueError("both annotators must submit before expert completion")
                    validate_record(source,task)
                if not str(record.get("adjudication_note","")).strip():
                    raise ValueError("expert completion requires an adjudication note")
        result = {**validated, "annotator":who, "role":"expert" if expert else "annotator",
                  "revision":revision+1, "updated_at":time.strftime("%Y-%m-%d %H:%M:%S"),
                  "task_provenance":task.get("provenance",{})}
        # Keep every committed revision. Original A1/A2 files are never replaced by the expert.
        history = Path(HERE)/"annotations"/who/"history"/vid
        if old:
            write_json(history/f"{revision:06d}.json",old)
        write_json(annotation_path(who,vid),result)
        return result


class Handler(SimpleHTTPRequestHandler):
    transcripts_dir = None
    annotators = ("A1","A2")
    expert_id = "EXPERT"
    auth_users = None

    def _authenticate(self):
        if self.auth_users is None:
            self.auth_identity = None
            return True
        try:
            scheme, encoded = self.headers.get('Authorization', '').split(' ', 1)
            if scheme.lower() != 'basic':
                raise ValueError('invalid scheme')
            who, password = base64.b64decode(encoded, validate=True).decode().split(':', 1)
            entry = self.auth_users.get(who)
            if entry:
                actual = hashlib.pbkdf2_hmac('sha256', password.encode(), bytes.fromhex(entry['salt']), 200000).hex()
                if hmac.compare_digest(actual, entry['hash']):
                    self.auth_identity = who
                    return True
        except (ValueError, UnicodeError):
            pass
        self.send_response(401)
        self.send_header('WWW-Authenticate', 'Basic realm="THVL Annotation", charset="UTF-8"')
        self.send_header('Content-Length', '0')
        self.end_headers()
        return False

    def log_message(self,*args):
        pass

    def end_headers(self):
        self.send_header("Cache-Control","no-store")
        super().end_headers()

    def _json(self,code,obj):
        body=json.dumps(obj,ensure_ascii=False,allow_nan=False).encode()
        compressed = len(body)>1024 and 'gzip' in self.headers.get('Accept-Encoding','')
        if compressed:
            body=gzip.compress(body,compresslevel=1)
        self.send_response(code)
        if compressed:
            self.send_header('Content-Encoding','gzip')
            self.send_header('Vary','Accept-Encoding')
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _query(self,key):
        return parse_qs(urlsplit(self.path).query).get(key,[None])[0]

    def _who(self):
        who=self._query("annotator")
        if who not in (*self.annotators,self.expert_id):
            raise ValueError("unknown annotator")
        if self.auth_users is not None and who != self.auth_identity:
            raise ValueError('workspace access denied')
        return who

    def _video(self):
        vid=self._query("video_id")
        if not valid_id(vid) or vid not in tasks_by_id():
            raise ValueError("unregistered video")
        return vid

    def _stream_video(self,vid):
        if not valid_id(vid):
            return self._json(400,{"error":"invalid video ID"})
        path=load_media_map().get(vid)
        if not path or not Path(path).is_file():
            return self._json(404,{"error":"media unavailable"})
        size=Path(path).stat().st_size
        start,end,status=0,size-1,200
        header=self.headers.get("Range")
        if header:
            match=re.fullmatch(r"bytes=(\d*)-(\d*)",header)
            if not match or not any(match.groups()) or not size:
                return self._json(416,{"error":"invalid byte range"})
            if match[1]:
                start=int(match[1]);end=min(int(match[2]),end) if match[2] else end
            else:
                if int(match[2]) <= 0:
                    return self._json(416,{"error":"invalid suffix range"})
                start=max(0,size-int(match[2]))
            if start > end or start >= size:
                self.send_response(416);self.send_header("Content-Range",f"bytes */{size}")
                self.send_header("Content-Length","0");self.end_headers();return
            status=206
        self.send_response(status)
        self.send_header("Content-Type",VIDEO_TYPES.get(Path(path).suffix.lower(),mimetypes.guess_type(path)[0] or "application/octet-stream"))
        self.send_header("Accept-Ranges","bytes")
        self.send_header("Content-Length",str(end-start+1))
        if status==206:
            self.send_header("Content-Range",f"bytes {start}-{end}/{size}")
        self.end_headers()
        if self.command=="HEAD":
            return
        with open(path,"rb") as fh:
            fh.seek(start);remaining=end-start+1
            while remaining>0:
                chunk=fh.read(min(1<<20,remaining))
                if not chunk:break
                try:self.wfile.write(chunk)
                except (BrokenPipeError,ConnectionResetError):break
                remaining-=len(chunk)

    def do_GET(self):
        if not self._authenticate():
            return
        path=unquote(urlsplit(self.path).path)
        try:
            if path=="/api/config":
                return self._json(200,{"annotators":self.annotators,"expert_id":self.expert_id,"authenticated_user":self.auth_identity})
            if path.startswith("/media/"):
                return self._stream_video(path[len("/media/"):])
            if path=="/api/progress":
                who=self._who()
                progress={}
                for vid in tasks_by_id():
                    rec=load_annotation(who,vid)
                    if rec:
                        progress[vid]={"status":rec.get("status"),"segments":len(rec.get("segments",[])),
                                       "updated_at":rec.get("updated_at"),"revision":rec.get("revision")}
                return self._json(200,progress)
            if path=="/api/load":
                return self._json(200,load_annotation(self._who(),self._video()))
            if path=="/api/expert-context":
                if self._who()!=self.expert_id:
                    return self._json(403,{"error":"expert entry required"})
                return self._json(200,expert_context(self._video(),self.annotators))
            if path=="/api/transcript":
                vid=self._video()
                data=read_json(Path(self.transcripts_dir)/f"{vid}.json") if self.transcripts_dir else None
                return self._json(200,data or {"status":"missing","segments":[]})
            if path in ("/","/index.html"):
                path="/annotate.html"
            if path == '/tasks.json':
                return self._json(200,list(tasks_by_id().values()))
            if path.lstrip("/") in STATIC:
                self.path=path
                self.directory = HERE if path == "/tasks.json" else str(Path(__file__).resolve().parent)
                return super().do_HEAD() if self.command == "HEAD" else super().do_GET()
            return self._json(404,{"error":"not found"})
        except ValueError as exc:
            return self._json(400,{"error":str(exc)})
        except Exception as exc:
            return self._json(500,{"error":str(exc)})

    def do_HEAD(self):
        self.do_GET()

    def do_POST(self):
        if not self._authenticate():
            return
        origin = self.headers.get('Origin')
        if (origin and urlsplit(origin).netloc != self.headers.get('Host')) or self.headers.get('Sec-Fetch-Site') == 'cross-site':
            return self._json(403,{'error':'cross-origin write denied'})
        if urlsplit(self.path).path!="/api/save":
            return self._json(404,{"error":"not found"})
        try:
            length=int(self.headers.get("Content-Length","0"))
            if not 0 < length <= 5*1024*1024:
                return self._json(413,{"error":"invalid request size"})
            data=json.loads(self.rfile.read(length))
            if self.auth_users is not None and data.get('annotator') != self.auth_identity:
                return self._json(403,{'error':'workspace access denied'})
            result=save_annotation(data.get("annotator"),data.get("record"),data.get("expected_revision"),
                                   self.annotators,self.expert_id)
            return self._json(200,{"ok":True,"updated_at":result["updated_at"],"revision":result["revision"]})
        except ConflictError as exc:
            return self._json(409,{"error":str(exc)})
        except (ValueError,TypeError,KeyError) as exc:
            return self._json(400,{"error":str(exc)})
        except Exception as exc:
            return self._json(500,{"error":str(exc)})


def main():
    global HERE, PROXY_INDEX
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port",type=int,default=8800)
    parser.add_argument("--host",default="127.0.0.1")
    parser.add_argument("--data-dir",default=HERE,help="tasks/media_map and annotations directory")
    parser.add_argument("--transcripts")
    parser.add_argument("--proxy-index",help="Validated browser_proxy.py index; originals are not modified")
    parser.add_argument("--annotators",nargs=2,default=["A1","A2"])
    parser.add_argument("--expert-id",default="EXPERT")
    parser.add_argument('--auth-file',help='Private account hashes; remote access requires HTTPS')
    args=parser.parse_args()
    HERE=str(Path(args.data_dir).resolve())
    PROXY_INDEX=args.proxy_index
    if len(set(args.annotators+[args.expert_id]))!=3 or not all(valid_id(x) for x in args.annotators+[args.expert_id]):
        parser.error("require three distinct safe annotator/expert IDs")
    if not tasks_by_id():
        parser.error("missing tasks.json; run build_tasks.py first")
    Handler.transcripts_dir=args.transcripts
    Handler.annotators=tuple(args.annotators);Handler.expert_id=args.expert_id
    Handler.auth_users=read_json(args.auth_file) if args.auth_file else None
    if args.auth_file and (not isinstance(Handler.auth_users,dict) or set(Handler.auth_users)!=set(args.annotators+[args.expert_id])):
        parser.error('auth file must contain exactly the configured accounts')
    # Serve the shipped UI while task/annotation storage may be elsewhere.
    server=ThreadingHTTPServer((args.host,args.port),partial(Handler,directory=HERE))
    print(f"Annotation store: {HERE}",flush=True)
    for who in args.annotators+[args.expert_id]:
        print(f"http://localhost:{args.port}/?annotator={who}",flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()


if __name__=="__main__":
    main()
