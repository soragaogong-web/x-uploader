# x-uploader

## x2drive（X→Drive の大きい動画の保存）

- `x2drive.py` / `.github/workflows/x2drive.yml`
- X→Drive の Apps Script が 50MB を超える動画を見つけると、このワークフローを起動する
- Secrets: `X2D_GAS_URL`（X→Drive のウェブアプリURL）、`X2D_KEY`（合言葉）
- 自動ローテ（`upload.py` / `upload.yml`）とは別の処理で、お互いに影響しない
