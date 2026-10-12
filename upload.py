"""
自動ローテ: 動画アップロード係(GitHub Actions で動く)

1. GAS の Web アプリから「アップロード待ちの予定」を受け取る
2. Google ドライブから動画をダウンロードする
3. X に動画をアップロードする(initialize → append → finalize → STATUS 待ち)
4. 動画ID を GAS に返す(投稿は GAS が予定時刻に行う)

このリポジトリは公開なので、ログ(画面に出る文字)には
キー・トークン・ファイル名を出さないようにしている。
"""
import os
import sys
import tempfile
import time

import requests
from requests_oauthlib import OAuth1

GAS_URL = os.environ["GAS_URL"]
AR_KEY = os.environ["AR_KEY"]
X_UPLOAD = "https://api.x.com/2/media/upload"
CHUNK = 4 * 1024 * 1024
RUN_LIMIT_SEC = 25 * 60


def mask(value):
    """GitHub のログに出ても伏せ字になるよう登録する"""
    if value:
        print(f"::add-mask::{value}", flush=True)


def gas(params):
    params = dict(params, key=AR_KEY)
    r = requests.get(GAS_URL, params=params, timeout=120)
    r.raise_for_status()
    return r.json()


def download(file_id, token, path):
    url = f"https://www.googleapis.com/drive/v3/files/{file_id}?alt=media&supportsAllDrives=true"
    with requests.get(url, headers={"Authorization": f"Bearer {token}"}, stream=True, timeout=600) as r:
        if r.status_code != 200:
            raise RuntimeError(f"Googleドライブから動画を取れません({r.status_code})")
        with open(path, "wb") as f:
            for part in r.iter_content(1024 * 1024):
                f.write(part)


def check(r, step):
    if r.status_code < 200 or r.status_code >= 300:
        raise RuntimeError(f"X {step} 失敗 {r.status_code}: {r.text[:250]}")
    return r


def upload_to_x(job, path):
    auth = OAuth1(job["ck"], job["cs"], job["t"], job["s"])
    total = os.path.getsize(path)
    mime = job.get("mime") or "video/mp4"

    r = check(requests.post(f"{X_UPLOAD}/initialize", auth=auth, timeout=60,
                            json={"media_type": mime, "media_category": "tweet_video", "total_bytes": total}),
              "initialize")
    data = r.json().get("data", {})
    media_id = str(data.get("id") or data.get("media_id") or "")
    if not media_id:
        raise RuntimeError("X initialize: 動画IDが返ってきません")

    with open(path, "rb") as f:
        index = 0
        while True:
            chunk = f.read(CHUNK)
            if not chunk:
                break
            check(requests.post(f"{X_UPLOAD}/{media_id}/append", auth=auth, timeout=300,
                                data={"segment_index": str(index)},
                                files={"media": ("chunk", chunk, "application/octet-stream")}),
                  f"append {index}")
            index += 1

    r = check(requests.post(f"{X_UPLOAD}/{media_id}/finalize", auth=auth, timeout=60), "finalize")
    info = (r.json().get("data") or {}).get("processing_info")
    waited = 0
    while info and info.get("state") not in ("succeeded",):
        if info.get("state") == "failed":
            err = info.get("error") or {}
            raise RuntimeError(f"Xでの動画処理に失敗: {err.get('message') or err}")
        sec = min(max(int(info.get("check_after_secs") or 5), 2), 15)
        time.sleep(sec)
        waited += sec
        if waited > 600:
            raise RuntimeError("Xでの動画処理が10分たっても終わりません")
        r = check(requests.get(X_UPLOAD, auth=auth, timeout=60,
                               params={"command": "STATUS", "media_id": media_id}), "STATUS")
        info = (r.json().get("data") or {}).get("processing_info")
    return media_id


def main():
    started = time.time()
    done = 0
    while time.time() - started < RUN_LIMIT_SEC:
        res = gas({"ar": "jobs"})
        if not res.get("ok"):
            print("GASとの接続に失敗しました(GAS_URL / AR_KEY を確認)", flush=True)
            sys.exit(1)
        token = res.get("driveToken", "")
        jobs = res.get("jobs", [])
        mask(token)
        for j in jobs:
            for k in ("ck", "cs", "t", "s"):
                mask(j.get(k))
        if not jobs:
            break
        for job in jobs:
            print(f"予定 {job['id']}: 開始({round((job.get('size') or 0) / 1024 / 1024)}MB)", flush=True)
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, "video")
                try:
                    download(job["fileId"], token, path)
                    media_id = upload_to_x(job, path)
                    gas({"ar": "done", "job": job["id"], "media": media_id})
                    print(f"予定 {job['id']}: 完了", flush=True)
                    done += 1
                except Exception as e:  # noqa: BLE001
                    msg = str(e)[:300]
                    print(f"予定 {job['id']}: 失敗 {msg}", flush=True)
                    try:
                        gas({"ar": "fail", "job": job["id"], "err": msg})
                    except Exception:  # noqa: BLE001
                        pass
    print(f"おわり(アップロード {done}件)", flush=True)


if __name__ == "__main__":
    main()
