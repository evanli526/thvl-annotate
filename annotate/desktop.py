"""Local annotation UI with bundled suggestions and on-demand cloud video streaming."""
import argparse
import gzip
import hashlib
import json
import re
import threading
import webbrowser
from functools import partial
from pathlib import Path
from urllib.parse import quote
from urllib.request import Request, urlopen
from http.server import ThreadingHTTPServer
import serve
from common import write_json

RELEASE=Path(__file__).resolve().parent/'releases/quality_review_20260914'


def prepare(release,workspace):
    meta=json.loads((release/'release.json').read_text())
    payload={}
    for name in ('tasks.json.gz','transcripts.json.gz'):
        raw=(release/name).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=meta['files'][name]['sha256']:
            raise ValueError('标注包校验失败，请重新获取仓库：'+name)
        payload[name]=json.loads(gzip.decompress(raw))
    tasks=payload['tasks.json.gz'];current=workspace/'tasks.json'
    if current.exists() and json.loads(current.read_text())!=tasks:
        raise ValueError('此工作目录属于不同任务版本，请换用 --workspace，勿覆盖已有结果')
    if not current.exists():write_json(current,tasks)
    for vid,data in payload['transcripts.json.gz'].items():
        if not serve.valid_id(vid):raise ValueError('invalid video id')
        write_json(workspace/'transcripts'/f'{vid}.json',data)
    sources={vid:{**item,'url':'https://huggingface.co/datasets/'+meta['dataset_repo']+'/resolve/'+meta['dataset_revision']+'/'+quote(item['relative_path'])} for vid,item in meta['media'].items()}
    return meta,tasks,sources


def byte_range(header,size,limit=8*1024*1024):
    start,end=0,size-1
    if header:
        match=re.fullmatch(r'bytes=(\d*)-(\d*)',header)
        if not match or not any(match.groups()):raise ValueError('invalid range')
        if match[1]:
            start=int(match[1]);end=min(end,int(match[2])) if match[2] else end
        else:
            suffix=int(match[2])
            if suffix<=0:raise ValueError('invalid suffix')
            start=max(0,size-suffix)
    if start>end or start>=size:raise ValueError('range outside media')
    return start,min(end,start+limit-1)


class CloudHandler(serve.Handler):
    sources={}
    def _stream_video(self,vid):
        item=self.sources.get(vid)
        if item is None:return self._json(404,{'error':'原数据集缺少该视频，不可判为无风险'})
        try:start,end=byte_range(self.headers.get('Range'),item['size_bytes'])
        except ValueError:return self._json(416,{'error':'invalid range'})
        try:
            upstream=urlopen(Request(item['url'],headers={'Range':f'bytes={start}-{end}'}),timeout=45)
            expected=f"bytes {start}-{end}/{item['size_bytes']}"
            if upstream.status!=206 or upstream.headers.get('Content-Range')!=expected:
                upstream.close();return self._json(502,{'error':'云端未按请求返回视频分段，请稍后重试'})
        except Exception:
            return self._json(502,{'error':'云端视频连接失败，请检查网络后重试；不要判为无风险'})
        with upstream:
            self.send_response(206)
            self.send_header('Content-Type',upstream.headers.get('Content-Type','video/mp4'))
            self.send_header('Content-Length',str(end-start+1))
            self.send_header('Content-Range',expected)
            self.send_header('Accept-Ranges','bytes')
            self.end_headers()
            if self.command=='HEAD':return
            remaining=end-start+1
            try:
                while remaining:
                    block=upstream.read(min(256*1024,remaining))
                    if not block:break
                    self.wfile.write(block);remaining-=len(block)
            except (BrokenPipeError,ConnectionResetError):pass


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('--annotator',choices=['A1','A2','EXPERT'])
    p.add_argument('--port',type=int,default=8800)
    p.add_argument('--workspace',type=Path,default=Path(__file__).resolve().parents[1]/'.annotation-work/desktop-quality_review_20260914')
    p.add_argument('--release',type=Path,default=RELEASE)
    p.add_argument('--no-browser',action='store_true')
    p.add_argument('--prepare-only',action='store_true')
    a=p.parse_args()
    who=a.annotator
    if not who:
        who=input('请输入工作代号 A1 / A2 / EXPERT（由负责人分配，不需要密码）：').strip().upper()
        if who not in ('A1','A2','EXPERT'):p.error('请输入 A1、A2 或 EXPERT')
    meta,tasks,sources=prepare(a.release,a.workspace.resolve())
    print(f"已准备 {len(tasks)} 条视频任务、{meta['segments']} 条机器建议。视频按需联网播放，不下载整库。",flush=True)
    print('你的标注保存在：',a.workspace.resolve()/'annotations'/who,flush=True)
    if a.prepare_only:return
    serve.HERE=str(a.workspace.resolve());serve.PROXY_INDEX=None
    CloudHandler.auth_users=None;CloudHandler.sources=sources
    CloudHandler.transcripts_dir=str(a.workspace.resolve()/'transcripts')
    handler=partial(CloudHandler,directory=serve.HERE)
    try:server=ThreadingHTTPServer(('127.0.0.1',a.port),handler)
    except OSError:server=ThreadingHTTPServer(('127.0.0.1',0),handler)
    url=f'http://127.0.0.1:{server.server_port}/?annotator={who}'
    print('浏览器地址：'+url+'\n请保持此终端运行；结束时按 Ctrl+C。',flush=True)
    if not a.no_browser:
        timer=threading.Timer(.5,lambda:webbrowser.open(url));timer.daemon=True;timer.start()
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.server_close()

if __name__=='__main__':main()
