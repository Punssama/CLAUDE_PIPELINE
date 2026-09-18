# claude-pipeline

Plugin Claude Code chạy một pipeline tự động nhiều model trên repo git của bạn:

```
Plan (Opus 5) → Build (Sonnet 5) → test gate → Review (Sonnet 5, chỉ đọc) → Commit + push (Haiku 4.5, không sửa code)
                     ↑________ sửa lỗi nếu review/test FAIL (tối đa N vòng) ________|
```

Mỗi bước là một phiên `claude -p` riêng, **quyền bị khoá bằng danh sách công cụ** (không chỉ bằng lời dặn): planner chỉ ghi được `plan.md`, reviewer chỉ ghi được `review.md` và chạy git đọc, committer không có công cụ sửa file. Nếu vẫn FAIL sau các vòng sửa → **không commit gì**.

## Cài đặt

Yêu cầu: [Claude Code](https://claude.com/claude-code), `git`, Node.js ≥ 18. Chạy được trên Windows, macOS, Linux.

Trong Claude Code:

```
/plugin marketplace add Punssama/CLAUDE_PIPELINE
/plugin install claude-pipeline@punssama
```

Mở session mới để plugin được nạp.

Cập nhật bản mới: `/plugin marketplace update punssama`. Gỡ: `/plugin uninstall claude-pipeline@punssama`.

## Dùng

Trong một repo git **sạch** (đã commit hết):

```
/setup-pipeline thêm endpoint /health trả về {"status":"ok"} kèm test
```

(Nếu trùng tên với skill khác: `/claude-pipeline:setup-pipeline ...`)

Claude sẽ:
1. Hỏi cho rõ yêu cầu nếu còn mơ hồ (pipeline chạy ngầm nên không hỏi lại được).
2. Hỏi bạn chọn **skill cho từng bước** (Plan / Build / Review / Commit).
3. Hỏi lệnh test, có dừng sau plan không, có push không.
4. Ghi `.pipeline/config.json` rồi chạy trên nhánh mới `auto/<tên>` (không bao giờ chạy trên `main`/`master`, không force-push).

Kết quả:

| Mã thoát | Ý nghĩa |
|---|---|
| 0 | Đã commit (và push nếu bật) |
| 10 | Dừng sau plan → đọc `.pipeline/plan.md`, rồi chạy tiếp `--from build` |
| 2 | Review/test vẫn FAIL → xem `.pipeline/review.md`, không có gì được commit |
| 1 | Lỗi → xem `.pipeline/logs/` |

Chạy tiếp từ giữa: `--from build | review | commit`.

## Cấu hình (`.pipeline/config.json`)

```json
{
  "task": "mô tả cụ thể việc cần làm",
  "branch": "auto/ten-nhanh",
  "testCmd": "npm test",
  "pauseAfterPlan": true,
  "maxFixLoops": 2,
  "push": false,
  "steps": {
    "plan":   { "model": "claude-opus-5",             "budgetUsd": 3,   "skills": ["planning-and-task-breakdown"] },
    "build":  { "model": "claude-sonnet-5",           "budgetUsd": 6,   "skills": ["test-driven-development"] },
    "review": { "model": "claude-sonnet-5",           "budgetUsd": 2,   "skills": ["code-review-and-quality"] },
    "commit": { "model": "claude-haiku-4-5-20251001", "budgetUsd": 0.5, "skills": [] }
  }
}
```

`skills` là tên skill **đã cài trên máy bạn** (vd từ [agent-skills](https://github.com/addyosmani/agent-skills), superpowers…). Không có cũng chạy được.

## Lưu ý

- **Tốn tiền API thật.** `budgetUsd` là trần cho mỗi bước; mặc định tối đa ~11,5 USD/lượt (mỗi vòng sửa tốn thêm Build + Review).
- Bước Build được chạy lệnh shell (trừ commit/push/reset/đổi nhánh). Chỉ chạy trên repo bạn tin tưởng.
- Nên để `pauseAfterPlan: true` vài lần đầu để đọc plan trước khi code.
- Đang ở bản thử nghiệm (0.1.0): đã test trọn vẹn với Haiku; chưa test đầy đủ với Opus/Sonnet và nhánh push.

## Giấy phép

MIT
