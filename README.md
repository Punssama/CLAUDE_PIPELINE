# claude-pipeline

Plugin Claude Code chạy một pipeline tự động nhiều model trên repo git của bạn:

```
Plan (Opus 5) → Build (Sonnet 5) → test gate → Review (Sonnet 5, chỉ đọc) → Commit + push (Haiku 4.5, không sửa code)
                     ↑________ sửa lỗi nếu review/test FAIL (tối đa N vòng) ________|
```

Mỗi bước là một phiên `claude -p` riêng, **quyền bị khoá bằng danh sách công cụ** (không chỉ bằng lời dặn): planner chỉ ghi được `plan.md`, reviewer chỉ ghi được `review.md` và chạy git đọc, committer không có công cụ sửa file. Nếu vẫn FAIL sau các vòng sửa → **không commit gì**.

## Cài đặt

### Bước 1: Kiểm tra máy đã có đủ 3 thứ

Mở terminal (Windows: PowerShell; macOS/Linux: Terminal) và chạy:

```bash
claude --version   # Claude Code
git --version      # Git
node --version     # Node.js, cần v18 trở lên
```

Thiếu cái nào thì cài cái đó:

| Thiếu | Cài |
|---|---|
| `claude` | https://docs.claude.com/en/docs/claude-code/setup, rồi chạy `claude` một lần để đăng nhập |
| `git` | Windows: https://git-scm.com/download/win · macOS: `xcode-select --install` · Linux: `sudo apt install git` |
| `node` | https://nodejs.org (bản LTS) |

Cài xong thì **mở terminal mới** rồi chạy lại 3 lệnh trên để chắc chắn.

### Bước 2: Cài plugin

Mở Claude Code (gõ `claude` trong terminal), rồi gõ lần lượt **2 lệnh** này vào ô chat:

```
/plugin marketplace add Punssama/CLAUDE_PIPELINE
```

```
/plugin install claude-pipeline@punssama
```

Nếu được hỏi phạm vi cài (scope), chọn **user** để dùng được ở mọi dự án.

<details>
<summary>Cách khác: cài bằng lệnh terminal (không cần mở Claude Code)</summary>

```bash
claude plugin marketplace add Punssama/CLAUDE_PIPELINE
claude plugin install claude-pipeline@punssama
```

</details>

### Bước 3: Khởi động lại và kiểm tra

1. Thoát Claude Code (`/exit`) rồi mở lại. Plugin chỉ được nạp khi session mới bắt đầu.
2. Gõ `/plugin`, vào tab **Installed**: phải thấy `claude-pipeline` ở trạng thái **enabled**.
   Hoặc chạy trong terminal: `claude plugin list`.
3. Gõ `/setup` trong ô chat: danh sách gợi ý phải có `setup-pipeline`.

Xong. Chuyển sang phần [Dùng](#dùng).

### Cập nhật lên bản mới

```
/plugin marketplace update punssama
```

rồi khởi động lại Claude Code.

### Gỡ cài đặt

```
/plugin uninstall claude-pipeline@punssama
/plugin marketplace remove punssama
```

### Gặp lỗi khi cài

| Lỗi | Cách sửa |
|---|---|
| `Permission denied (publickey)` khi `marketplace add` | Máy chưa có SSH key GitHub. Dùng URL HTTPS: `/plugin marketplace add https://github.com/Punssama/CLAUDE_PIPELINE.git`. Vẫn lỗi thì chạy một lần: `git config --global url."https://github.com/".insteadOf git@github.com:` |
| Gõ `/setup-pipeline` không thấy | Chưa khởi động lại Claude Code. Nếu trùng tên với skill khác, gõ đầy đủ `/claude-pipeline:setup-pipeline` |
| Pipeline báo `cannot run claude` | `claude` không nằm trong PATH của terminal. Mở terminal mới rồi chạy `claude --version`; nếu không chạy được thì cài lại Claude Code |
| `node: command not found` | Chưa cài Node.js, hoặc chưa mở terminal mới sau khi cài |
| `working tree not clean` | Repo còn thay đổi chưa commit. Chạy `git add -A && git commit -m "wip"` (hoặc `git stash`) trước |
| `refusing to run on main` | Bình thường: pipeline tự tạo nhánh `auto/...` khi chạy từ đầu. Lỗi này chỉ xảy ra khi chạy `--from ...` mà đang đứng ở `main` |

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
