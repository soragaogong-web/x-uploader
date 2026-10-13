"""
X→Drive: 大きい動画（50MB超）の保存係（GitHub Actions で動く）

Apps Script は 50MB を超えるファイルを受け取れないため、そういう動画だけをここで保存する。

1. GAS の Web アプリから「保存待ちの動画」と、ドライブに書き込むための一時的な鍵を受け取る
2. X から動画をダウンロードする
3. Google ドライブのアカウントのフォルダにアップロードする
4. 結果（ファイルID・MD5）を GAS に返す（重複チェックは GAS がする）

このリポジトリは公開なので、ログ（画面に出る文字）には
キー・トークン・URL・ファイル名を出さないようにしている。
"""
import hashlib
import json
import os
import sys
import tempfile
import time

import requests

GAS_URL = os.environ["X2D_GAS_URL"]
X2D_KEY = os.environ["X2D_KEY"]
DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true"
RUN_LIMIT_SEC = 25 * 60


def mask(value):
    """GitHub のログに出ても伏せ字になるよう登録する"""
    if value:
        print(f"::add-mask::{value}", flush=True)


def gas(params):
    params = dict(params, key=X2D_KEY)
    r = requests.get(GAS_URL, params=params, timeout=120)
    r.raise_for_status()
    return r.json()


def download(url, path):
    """X から動画をダウンロード。MD5 とサイズを返す"""
    md5 = hashlib.md5()
    size = 0
    with requests.get(url, stream=True, timeout=600, headers={"User-Agent": "Mozilla/5.0 (x2drive)"}) as r:
        if r.status_code != 200:
            raise RuntimeError(f"Xから動画を取れません({r.status_code})")
        with open(path, "wb") as f:
            for part in r.iter_content(1024 * 1024):
                f.write(part)
                md5.update(part)
                size += len(part)
    if size == 0:
        raise RuntimeError("Xから取れた動画が空でした")
    return md5.hexdigest(), size


def upload_to_drive(token, path, name, folder_id, size):
    """ドライブにアップロード（大きいファイル用の resumable upload）。ファイルIDを返す"""
    r = requests.post(
        DRIVE_UPLOAD,
        timeout=60,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "video/mp4",
            "X-Upload-Content-Length": str(size),
        },
        data=json.dumps({"name": name, "parents": [folder_id]}),
    )
    if r.status_code != 200 or "Location" not in r.headers:
        raise RuntimeError(f"ドライブのアップロード開始に失敗({r.status_code}): {r.text[:200]}")
    location = r.headers["Location"]

    with open(path, "rb") as f:
        r = requests.put(location, data=f, timeout=1800,
                         headers={"Content-Type": "video/mp4", "Content-Length": str(size)})
    if r.status_code not in (200, 201):
        raise RuntimeError(f"ドライブへのアップロードに失敗({r.status_code}): {r.text[:200]}")
    file_id = (r.json() or {}).get("id")
    if not file_id:
        raise RuntimeError("ドライブからファイルIDが返ってきません")
    return file_id


def main():
    started = time.time()
    done = 0
    while time.time() - started < RUN_LIMIT_SEC:
        res = gas({"x2d": "jobs"})
        if not res.get("ok"):
            print("GASとの接続に失敗しました(X2D_GAS_URL / X2D_KEY を確認)", flush=True)
            sys.exit(1)
        token = res.get("driveToken", "")
        jobs = res.get("jobs", [])
        mask(token)
        for j in jobs:
            mask(j.get("url"))
        if not jobs:
            break
        for job in jobs:
            print(f"動画 {job['id'][:8]}: 開始", flush=True)
            with tempfile.TemporaryDirectory() as tmp:
                path = os.path.join(tmp, "video")
                try:
                    md5, size = download(job["url"], path)
                    file_id = upload_to_drive(token, path, job["name"], job["folderId"], size)
                    gas({"x2d": "done", "job": job["id"], "file": file_id, "md5": md5, "size": size})
                    print(f"動画 {job['id'][:8]}: 完了({round(size / 1024 / 1024)}MB)", flush=True)
                    done += 1
                except Exception as e:  # noqa: BLE001
                    msg = str(e)[:300]
                    print(f"動画 {job['id'][:8]}: 失敗", flush=True)
                    try:
                        gas({"x2d": "fail", "job": job["id"], "err": msg})
                    except Exception:  # noqa: BLE001
                        pass
    print(f"おわり(保存 {done}件)", flush=True)


if __name__ == "__main__":
    main()
