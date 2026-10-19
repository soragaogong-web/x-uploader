"""
X Chat(新しいチャット・暗号化つき)のグループへ送る係(GitHub Actions で動く)

1. GAS の Web アプリ(?ar=xc_jobs)から「送る文」と OAuth 2.0 のトークン・鍵を受け取る
2. 鍵を用意する(初回だけ、チャットのパスコードで鍵を取り出して GAS に保存してもらう)
3. グループの会話の鍵を取り出し、Chat XDK で文を暗号化・署名して送る
4. 結果を GAS に返す(?ar=xc_done / xc_fail)

このリポジトリは公開なので、ログ(画面に出る文字)には
トークン・鍵・パスコード・本文・会話IDを出さないようにしている。
"""
import base64
import json
import os
import re
import sys
import time

import requests
from urllib.parse import urljoin
from chat_xdk import Chat, guesses_remaining

GAS_URL = os.environ["GAS_URL"]
AR_KEY = os.environ["AR_KEY"]
API = "https://api.x.com"


def mask(value):
    """GitHub のログに出ても伏せ字になるよう登録する"""
    if value:
        print(f"::add-mask::{value}", flush=True)


def gas(params, tries=4):
    """GAS とやりとりする。混んでいて変な返事が来たときは、少し待って何回かやり直す"""
    params = dict(params, key=AR_KEY)
    last = None
    for i in range(tries):
        try:
            r = requests.get(GAS_URL, params=params, timeout=120)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"GASとの通信に失敗({params.get('ar')}): {str(last)[:120]}")


class X:
    """X API(OAuth 2.0 のトークンで呼ぶ)"""

    def __init__(self, token):
        self.h = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    def _check(self, r, what):
        if r.status_code < 200 or r.status_code >= 300:
            raise RuntimeError(f"{what}: {r.status_code} {r.text[:200]}")
        return r.json() if r.text.strip() else {}

    def get(self, path, params=None):
        return self._check(requests.get(API + path, headers=self.h, params=params, timeout=60), "GET " + path.split("?")[0])

    def post(self, path, body):
        return self._check(requests.post(API + path, headers=self.h, json=body, timeout=60), "POST " + path.split("?")[0])


def public_keys(x, user_id):
    data = x.get(f"/2/users/{user_id}/public_keys").get("data") or []
    return data if isinstance(data, list) else [data]


def load_chat(x, res, uid):
    """鍵を用意する。GAS に鍵があればそれを使い、無ければパスコードで取り出す"""
    if res.get("keys"):
        chat = Chat()
        chat.import_keys(base64.b64decode(res["keys"]), version=res.get("ver") or None)
        return chat, str(res.get("ver") or "1")
    pin = res.get("pin")
    if not pin:
        raise RuntimeError("チャットのパスコードが未登録です(GASのメニュー「X Chat ③」)")
    keys = public_keys(x, uid)
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
        gas({"ar": "xc_pinbad", "left": "" if left is None else str(left)})
        raise RuntimeError(f"パスコードが違うか、鍵を取り出せません(残り回数: {left})")
    blob = base64.b64encode(bytes(chat.export_keys())).decode("ascii")
    mask(blob)
    gas({"ar": "xc_keys", "keys": blob, "ver": ver})
    print("パスコードで鍵を取り出しました", flush=True)
    return chat, ver


def find_conv(x, want):
    """会話の一覧から、設定したグループ(g数字)を探す"""
    digits = re.sub(r"\D", "", want or "")
    data = x.get("/2/chat/conversations", {"max_results": 100}).get("data") or []
    ids = [str(c.get("id") or c.get("conversation_id") or "").replace(":", "-") for c in data]
    for cid in ids:
        if digits and digits in cid:
            return cid, ids
    return (want or "").replace(":", "-"), ids


def signing_keys_for(x, chat, user_ids):
    out = []
    for uid in user_ids:
        try:
            for pk in public_keys(x, uid):
                identity = pk.get("public_key") or ""
                signing = pk.get("signing_public_key") or ""
                sig = pk.get("identity_public_key_signature") or ""
                if identity and signing and sig and not chat.verify_key_binding(identity, signing, sig):
                    continue
                out.append({
                    "user_id": str(uid),
                    "public_key_version": str(pk.get("public_key_version") or ""),
                    "public_key": signing,
                    "identity_public_key": identity,
                    "identity_public_key_signature": sig,
                })
        except Exception:  # noqa: BLE001
            pass
    return out


def conv_key(x, chat, conv):
    """グループの会話の鍵(いちばん新しいもの)を取り出す"""
    key_events, encoded, senders, token = [], [], set(), None
    for _ in range(5):
        params = {"max_results": 100,
                  "chat_message_event.fields": "conversation_id,created_at,encoded_event,id,sender_id"}
        if token:
            params["pagination_token"] = token
        page = x.get(f"/2/chat/conversations/{conv}/events", params)
        meta = page.get("meta") or {}
        key_events += meta.get("conversation_key_events") or []
        for e in page.get("data") or []:
            if e.get("encoded_event"):
                encoded.append(e["encoded_event"])
            if e.get("sender_id"):
                senders.add(str(e["sender_id"]))
        token = meta.get("next_token")
        if key_events or not token:
            break
    keys = {}
    if key_events:
        try:
            keys = (chat.extract_conversation_keys(key_events) or {}).get("keys") or {}
        except Exception:  # noqa: BLE001
            keys = {}
    if not keys and (key_events or encoded):
        sk = signing_keys_for(x, chat, senders)
        if sk:
            chat.set_signing_keys(sk)
        r = chat.decrypt_events(key_events + encoded, sk or None)
        keys = ((r or {}).get("conversation_keys") or {}).get("keys") or {}
    if not keys:
        raise RuntimeError("グループの会話の鍵が見つかりません(@G_gayjp がグループに入っているか、アプリでグループを一度開いてみてください)")
    ver = max(keys, key=lambda v: int(v) if str(v).isdigit() else 0)
    return bytes(keys[ver]), str(ver)


UA = "Mozilla/5.0 (compatible; Twitterbot/1.0)"
BROWSER_UA = ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 "
              "(KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1")


def to_jpeg(data):
    from io import BytesIO
    from PIL import Image
    im = Image.open(BytesIO(data)).convert("RGB")
    out = BytesIO()
    im.save(out, "JPEG", quality=88)
    return out.getvalue()


def og_info(url):
    """リンク先のページから、プレビュー用の画像(og:image)とタイトル(og:title)を取る"""
    r = requests.get(url, headers={"User-Agent": UA, "Accept-Language": "ja"}, timeout=30, allow_redirects=True)
    html = r.text[:400000]
    base = r.url

    def meta(name):
        for pat in (rf'<meta[^>]+(?:property|name)=["\']{name}["\'][^>]*content=["\']([^"\']+)',
                    rf'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']{name}["\']'):
            m = re.search(pat, html, re.I)
            if m:
                return m.group(1).replace("&amp;", "&").strip()
        return ""

    img = meta("og:image") or meta("twitter:image")
    if img:
        img = urljoin(base, img)  # 「/images/…」のような書き方にも対応
    return img, meta("og:title") or meta("twitter:title"), base


def upload_chat_media(x, conv, cipher):
    """暗号化した画像を、その会話の保管場所にアップロードする → media_hash_key"""
    c = conv.replace("-", ":")
    d = x.post("/2/chat/media/upload/initialize", {"conversation_id": c, "total_bytes": len(cipher)}).get("data") or {}
    sid, mkey = d.get("session_id") or d.get("sessionId"), d.get("media_hash_key") or d.get("mediaHashKey")
    if not sid or not mkey:
        raise RuntimeError("画像のアップロードを始められません")
    n = 0
    for off in range(0, len(cipher), 3 * 1024 * 1024):
        x.post(f"/2/chat/media/upload/{sid}/append", {
            "conversation_id": c, "media_hash_key": mkey, "segment_index": str(n),
            "media": base64.b64encode(cipher[off:off + 3 * 1024 * 1024]).decode("ascii")})
        n += 1
    x.post(f"/2/chat/media/upload/{sid}/finalize", {"conversation_id": c, "media_hash_key": mkey, "num_parts": str(n)})
    return str(mkey)


def url_card(x, chat, conv, key, text, note):
    """文の中のURLを、作品の画像つきのカード(押せるプレビュー)にする。作れなければ None"""
    urls = re.findall(r"https?://\S+", text)
    if not urls:
        return None
    url = urls[-1]
    card = {"attachment_type": "url", "url": url}
    try:
        img_url, title, page = og_info(url)
        if title:
            card["display_title"] = title[:200]
        if not img_url:
            note.append("リンク先に作品の画像(og:image)が見つからない")
        else:
            ir = requests.get(img_url, headers={"User-Agent": BROWSER_UA, "Referer": page}, timeout=30)
            img = ir.content
            from chat_xdk import detect_image_dimensions, detect_mime_type
            mime = str(detect_mime_type(img) or "")
            if ir.status_code == 200 and mime.startswith("image/") and mime not in ("image/jpeg", "image/png"):
                img, mime = to_jpeg(img), "image/jpeg"  # webp などは、アプリで確実に出るように JPEG に直す
            if ir.status_code != 200 or not mime.startswith("image/"):
                note.append(f"作品の画像を取れない({ir.status_code} {mime or ir.headers.get('Content-Type', '')})")
            elif len(img) >= 5 * 1024 * 1024:
                note.append("作品の画像が大きすぎる")
            else:
                cipher = chat.encrypt_stream(img, key)
                dims = detect_image_dimensions(img) or (1200, 630)
                card["banner_image"] = {
                    "media_hash_key": upload_chat_media(x, conv, cipher),
                    "filesize_bytes": len(cipher),
                    "filename": "banner." + ("png" if "png" in mime else "jpg"),
                    "width": int(dims[0]), "height": int(dims[1]),
                }
    except Exception as e:  # noqa: BLE001
        note.append(f"プレビュー画像のエラー: {type(e).__name__} {str(e)[:150]}")
    if note:
        # 理由もログに出す(URLは伏せる)
        print("プレビュー画像は付けられませんでした: " + re.sub(r"https?://\S+", "(URL)", " / ".join(note)), flush=True)
    elif "banner_image" in card:
        print("プレビュー画像つきのカードを付けました", flush=True)
    return card


def url_entities(text):
    """本文の中のURLに「ここはリンク」の印を付ける。
    位置はアプリと同じ数え方(UTF-16。日本語は1文字=1、絵文字は2)にする。
    (UTF-8のバイト数で数えると、日本語が入った文ではアプリがリンクにしてくれなかった)"""
    u16 = lambda t: len(t.encode("utf-16-le")) // 2  # noqa: E731
    out = []
    for m in re.finditer(r"https?://[^\s]+", text):
        start = u16(text[:m.start()])
        out.append((start, start + u16(m.group(0)), "url"))
    return out


def main():
    res = gas({"ar": "xc_jobs"})
    if not res.get("ok"):
        print("GASとの接続に失敗しました(GAS_URL / AR_KEY を確認)", flush=True)
        sys.exit(1)
    jobs = res.get("jobs") or []
    if not jobs:
        print("送るものはありません", flush=True)
        return
    for k in ("token", "keys", "pin"):
        mask(res.get(k))
    print(f"{len(jobs)}通を送ります", flush=True)

    def fail_all(msg):
        for j in jobs:
            try:
                gas({"ar": "xc_fail", "id": j["id"], "err": msg[:300]})
            except Exception:  # noqa: BLE001
                pass
        print("失敗: 準備の段階でエラー(内容はスプレッドシートに書きました)", flush=True)
        sys.exit(1)

    if res.get("error") or not res.get("token"):
        fail_all(res.get("error") or "トークンがありません")
    x = X(res["token"])
    wants = res.get("convs") or ([res["conv"]] if res.get("conv") else [])
    if not wants:
        fail_all("送り先グループが設定されていません")
    try:
        uid = str(x.get("/2/users/me")["data"]["id"])
        chat, ver = load_chat(x, res, uid)
        chat.set_identity(uid, ver)
    except Exception as e:  # noqa: BLE001
        fail_all(str(e))
        return

    # 送り先グループごとに、会話IDと会話の鍵を用意する(複数のグループに同じ文を送る)
    groups, prep_err = [], []
    for n, want in enumerate(wants, 1):
        try:
            conv, ids = find_conv(x, want)
            if conv not in ids:
                gas({"ar": "xc_info", "msg": f"{n}つ目のグループが会話の一覧に見つかりません。見えている会話: {', '.join(ids[:15]) or 'なし'}"})
            key, kver = conv_key(x, chat, conv)
            groups.append((n, conv, key, kver))
        except Exception as e:  # noqa: BLE001
            prep_err.append(f"{n}つ目のグループ: {str(e)[:150]}")
    if not groups:
        fail_all(" / ".join(prep_err))
        return

    sent = 0
    for j in jobs:
        ok, errs, notes = 0, list(prep_err), []
        body = j["text"]
        ents = url_entities(body)
        for n, conv, key, kver in groups:
            try:
                note = []
                card = url_card(x, chat, conv, key, body, note)  # 画像はグループごとに暗号化してアップロード
                # 画像が付いたときだけカードにする(画像なしのカードは見た目が悪いので付けない)
                if card and "banner_image" not in card:
                    card = None
                try:
                    p = chat.encrypt_message(conv, body, conversation_key=key, conversation_key_version=kver,
                                             entities=ents or None, attachments=[card] if card else None)
                except Exception:  # noqa: BLE001
                    # カードつきで暗号化できないときは、文だけで送る
                    p = chat.encrypt_message(conv, body, conversation_key=key, conversation_key_version=kver,
                                             entities=ents or None)
                x.post(f"/2/chat/conversations/{conv}/messages", {
                    "message_id": p.message_id,
                    "encoded_message_create_event": p.encrypted_content,
                    "encoded_message_event_signature": p.encoded_event_signature,
                })
                ok += 1
                if note and not notes:
                    notes.append("プレビュー画像なし: " + " / ".join(note))
                print(f"{n}つ目のグループ: 送信OK", flush=True)
            except Exception as e:  # noqa: BLE001
                errs.append(f"{n}つ目のグループで失敗: {str(e)[:150]}")
                print(f"{n}つ目のグループ: 送信失敗(内容はスプレッドシートに書きました)", flush=True)
            time.sleep(2)
        if ok:
            gas({"ar": "xc_done", "id": j["id"], "note": " / ".join(errs + notes)[:300]})
            sent += 1
        else:
            gas({"ar": "xc_fail", "id": j["id"], "err": " / ".join(errs)[:300]})
        time.sleep(2)
    print(f"おわり(送信 {sent}/{len(jobs)}通)", flush=True)


if __name__ == "__main__":
    main()
