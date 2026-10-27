"""
DMグループ定期送信(複数アカウント × 複数グループ)の送信係(GitHub Actions で動く)

1. GAS の Web アプリ(?ar=gd_jobs)から「送る予定」と、アカウントごとのトークン・鍵を受け取る
2. アカウントごとに鍵を用意する(初回だけ、チャットのパスコードで鍵を取り出して GAS に保存してもらう)
3. 送る時刻まで待って、文章と画像/動画をそのグループの鍵で暗号化して送る
4. 結果を GAS に返す(?ar=gd_done / gd_fail)

このリポジトリは公開なので、ログには
トークン・鍵・パスコード・本文・会話ID・アカウント名を出さない。
"""
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

import requests
from chat_xdk import Chat, detect_image_dimensions, detect_mime_type, guesses_remaining

# X Chat(myfansDM)の送信係と同じ部品を使う
from xchat import X, conv_key, find_conv, gas, mask, public_keys, to_jpeg, upload_chat_media, url_entities

RUN_LIMIT_SEC = 50 * 60      # 1回の起動で動く最長時間(GitHub の上限より短く)
IDLE_LIMIT_SEC = 8 * 60      # 予定がこの時間なかったら終わる
POLL_SEC = 60                # GAS に新しい予定を聞きに行く間隔
CLAIM_AHEAD_SEC = 10 * 60    # この先何秒以内に送る予定を受け取るか
MAX_MEDIA_BYTES = 300 * 1024 * 1024


class Account:
    """1つのXアカウント(トークン・鍵・グループの鍵)"""

    def __init__(self, name, n):
        self.name = name          # GAS に返すとき用(ログには出さない)
        self.label = f"アカウント{n}"
        self.x = None
        self.chat = None
        self.convs = None         # 見えている会話の一覧
        self.keys = {}            # 会話ID → (鍵, 版)
        self.resolved = {}        # g数字 → (会話ID, 見えている会話の一覧)
        self.info = {}

    def set_token(self, token):
        if not token:
            return
        mask(token)
        if self.x:
            self.x.h["Authorization"] = f"Bearer {token}"
        else:
            self.x = X(token)

    def prepare(self, info):
        """初めてこのアカウントで送るときに、鍵を用意する"""
        if self.chat:
            return
        for k in ("keys", "pin"):
            mask(info.get(k))
        if info.get("error") or not self.x:
            raise RuntimeError(info.get("error") or "トークンがありません")
        uid = str(info.get("uid") or self.x.get("/2/users/me")["data"]["id"])
        if info.get("keys"):
            chat = Chat()
            chat.import_keys(base64.b64decode(info["keys"]), version=info.get("ver") or None)
            ver = str(info.get("ver") or "1")
        else:
            pin = info.get("pin")
            if not pin:
                raise RuntimeError("チャットのパスコードが未登録です(メニュー「③ チャットのパスコードを登録」)")
            keys = public_keys(self.x, uid)
            if not keys:
                raise RuntimeError("このアカウントにはX Chatの鍵がまだありません(アプリでチャットを開いてパスコードを設定してください)")
            latest = max(keys, key=lambda d: int(d.get("public_key_version") or 0))
            cfg = latest.get("juicebox_config")
            if not cfg:
                raise RuntimeError("鍵の保管場所の情報(juicebox_config)が取れません")
            ver = str(latest.get("public_key_version") or "1")
            chat = Chat(json.dumps(cfg))
            try:
                chat.unlock(pin)
            except Exception as e:  # noqa: BLE001
                left = guesses_remaining(e)
                gas({"ar": "gd_pinbad", "acct": self.name, "left": "" if left is None else str(left)})
                raise RuntimeError(f"パスコードが違うか、鍵を取り出せません(残り回数: {left})")
            blob = base64.b64encode(bytes(chat.export_keys())).decode("ascii")
            mask(blob)
            gas({"ar": "gd_keys", "acct": self.name, "keys": blob, "ver": ver})
            print(f"{self.label}: パスコードで鍵を取り出しました", flush=True)
        chat.set_identity(uid, ver)
        self.chat = chat

    def group(self, want):
        """グループ(g数字)の会話IDと鍵"""
        if want in self.resolved:
            conv, ids = self.resolved[want]
        else:
            conv, ids = self.resolved[want] = find_conv(self.x, want)
        if conv in self.keys:
            return conv, self.keys[conv]
        if conv not in ids:
            raise RuntimeError("このアカウントの会話の一覧にグループが見つかりません(グループに入っているか確認)")
        try:
            k = conv_key(self.x, self.chat, conv)
        except RuntimeError:
            raise RuntimeError("グループの会話の鍵が見つかりません(このアカウントがグループに入っているか、アプリでグループを一度開いてみてください)")
        self.keys[conv] = k
        return conv, k


class Media:
    """ドライブのファイル(1回だけダウンロードして、グループごとに暗号化する)"""
    cache = {}

    @classmethod
    def get(cls, fid, token):
        if fid in cls.cache:
            return cls.cache[fid]
        url = f"https://www.googleapis.com/drive/v3/files/{fid}?alt=media&supportsAllDrives=true"
        r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=600)
        if r.status_code != 200:
            raise RuntimeError(f"ドライブのファイルを取れません({r.status_code})。リンクが正しいか・同じGoogleアカウントのドライブにあるか確認")
        data = r.content
        if len(data) > MAX_MEDIA_BYTES:
            raise RuntimeError("画像/動画が大きすぎます(300MBまで)")
        mime = str(detect_mime_type(data) or r.headers.get("Content-Type", ""))
        info = {"data": data, "mime": mime}
        if mime.startswith("video/"):
            w, h, ms = video_info(data)
            info.update(kind=3, w=w, h=h, ms=ms, filename="video.mp4" if "mp4" in mime else "video.mov")
        elif mime.startswith("image/"):
            if mime == "image/gif":
                info.update(kind=2, filename="image.gif")
            else:
                if mime not in ("image/jpeg", "image/png"):
                    data, mime = to_jpeg(data), "image/jpeg"  # webp・heic などは JPEG に直す
                    info.update(data=data, mime=mime)
                info.update(kind=1, filename="image.png" if "png" in mime else "image.jpg")
            dims = detect_image_dimensions(info["data"]) or (1200, 1200)
            info.update(w=int(dims[0]), h=int(dims[1]))
        else:
            raise RuntimeError(f"画像か動画のファイルではありません({mime or '種類不明'})")
        cls.cache[fid] = info
        return info


def video_info(data):
    """動画の幅・高さ・長さ(ミリ秒)を調べる。ffprobe が無ければ pip の ffmpeg(imageio-ffmpeg)で調べる。だめなら仮の値"""
    with tempfile.NamedTemporaryFile(suffix=".mp4") as f:
        f.write(data)
        f.flush()
        try:
            if shutil.which("ffprobe"):
                out = subprocess.run(["ffprobe", "-v", "error", "-select_streams", "v:0",
                                      "-show_entries", "stream=width,height:format=duration", "-of", "json", f.name],
                                     capture_output=True, text=True, timeout=60).stdout
                j = json.loads(out or "{}")
                st = (j.get("streams") or [{}])[0]
                return int(st.get("width") or 1280), int(st.get("height") or 720), int(float((j.get("format") or {}).get("duration") or 0) * 1000)
            import imageio_ffmpeg
            err = subprocess.run([imageio_ffmpeg.get_ffmpeg_exe(), "-hide_banner", "-i", f.name],
                                 capture_output=True, text=True, timeout=60).stderr
            d = re.search(r"Duration: (\d+):(\d+):([\d.]+)", err)
            wh = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", err)
            ms = int((int(d.group(1)) * 3600 + int(d.group(2)) * 60 + float(d.group(3))) * 1000) if d else 0
            return (int(wh.group(1)), int(wh.group(2)), ms) if wh else (1280, 720, ms)
        except Exception:  # noqa: BLE001
            return 1280, 720, 0


def send(acct, j, drive_token):
    """1件(1アカウント → 1グループ)を送る"""
    conv, (key, kver) = acct.group(j["conv"])
    atts = []
    for fid in j.get("media") or []:
        if not drive_token:
            raise RuntimeError("ドライブのトークンがありません")
        m = Media.get(fid, drive_token)
        cipher = acct.chat.encrypt_stream(m["data"], key)  # グループごとの鍵で暗号化
        att = {"attachment_type": "media", "media_hash_key": upload_chat_media(acct.x, conv, cipher),
               "width": m["w"], "height": m["h"], "filesize_bytes": len(cipher),
               "filename": m["filename"], "media_type": m["kind"]}
        if m["kind"] == 3 and m.get("ms"):
            att["duration_millis"] = m["ms"]
        atts.append(att)
    text = j.get("text") or ""
    ents = url_entities(text)
    ttl = int(j.get("ttl") or 0)  # 消えるまでの時間(ミリ秒)。0 = 消えない
    p = acct.chat.encrypt_message(conv, text, conversation_key=key, conversation_key_version=kver,
                                  entities=ents or None, attachments=atts or None, ttl_msec=ttl or None)
    acct.x.post(f"/2/chat/conversations/{conv}/messages", {
        "message_id": p.message_id,
        "encoded_message_create_event": p.encrypted_content,
        "encoded_message_event_signature": p.encoded_event_signature,
    })
    return f"画像/動画{len(atts)}件つき" if atts else ""


def main():
    started = time.time()
    accounts = {}
    queue = []
    last_poll = 0
    last_job = time.time()
    drive_token = ""
    sent = 0
    while True:
        now = time.time()
        # 1) GAS に新しい予定を聞く
        if now - last_poll >= POLL_SEC and now - started < RUN_LIMIT_SEC - 60:
            last_poll = now
            until = min(now + CLAIM_AHEAD_SEC, started + RUN_LIMIT_SEC - 60)
            try:
                res = gas({"ar": "gd_jobs", "until": str(int(until * 1000))})
            except Exception as e:  # noqa: BLE001
                print(f"GASに聞けませんでした: {str(e)[:80]}", flush=True)
                res = {"ok": True, "jobs": []}
            if not res.get("ok"):
                print("GASとの接続に失敗しました(GAS_URL / AR_KEY を確認)", flush=True)
                sys.exit(1)
            if res.get("driveToken"):
                drive_token = res["driveToken"]
                mask(drive_token)
            for name, info in (res.get("accounts") or {}).items():
                if name not in accounts:
                    accounts[name] = Account(name, len(accounts) + 1)
                accounts[name].set_token(info.get("token"))
                # 前に受け取った鍵・パスコードは残したまま、新しい情報(トークンなど)だけ上書きする
                # (待っている間の問い合わせの返事には鍵・パスコードが入っていないので、丸ごと置き換えると消えてしまう)
                accounts[name].info.update({k: v for k, v in info.items() if v not in (None, "")})
                if info.get("token") and not info.get("error"):
                    accounts[name].info.pop("error", None)  # 前のエラーが直っていれば消す
            jobs = res.get("jobs") or []
            if jobs:
                queue.extend(jobs)
                queue.sort(key=lambda j: j.get("sendAt") or 0)
                last_job = now
                print(f"{len(jobs)}件の予定を受け取りました(待ち {len(queue)}件)", flush=True)
        # 2) 時刻が来た予定を送る
        while queue and (queue[0].get("sendAt") or 0) / 1000 <= time.time():
            j = queue.pop(0)
            acct = accounts.get(j.get("acct"))
            try:
                if not acct:
                    raise RuntimeError("アカウントの情報がありません")
                acct.prepare(acct.info)
                note = send(acct, j, drive_token)
                gas({"ar": "gd_done", "id": j["id"], "note": note})
                sent += 1
                print(f"{acct.label}: 送信OK", flush=True)
            except Exception as e:  # noqa: BLE001
                try:
                    gas({"ar": "gd_fail", "id": j["id"], "err": f"{type(e).__name__}: {str(e)[:250]}"})
                except Exception:  # noqa: BLE001
                    pass
                print(f"{acct.label if acct else '?'}: 送信失敗(内容はスプレッドシートに書きました)", flush=True)
            last_job = time.time()
            time.sleep(2)
        # 3) 終わるかどうか
        now = time.time()
        if not queue and (now - last_job > IDLE_LIMIT_SEC or now - started > RUN_LIMIT_SEC - 60):
            break
        if queue and now - started > RUN_LIMIT_SEC:
            break  # 送り切れなかった分は、GAS が時間切れでやり直す
        wait = POLL_SEC - (now - last_poll)
        if queue:
            wait = min(wait, (queue[0].get("sendAt") or 0) / 1000 - now)
        time.sleep(max(1, min(30, wait)))
    print(f"おわり(送信 {sent}件)", flush=True)


if __name__ == "__main__":
    main()
