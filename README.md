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

Trong một repo git:

```
/setup-pipeline thêm endpoint /health trả về {"status":"ok"} kèm test
```

(Nếu trùng tên với skill khác: `/claude-pipeline:setup-pipeline ...`)

### Claude sẽ làm gì (6 pha)

| Pha | Việc | Bạn cần làm |
|---|---|---|
| 0. Kiểm tra | Có git, node, claude; repo sạch | Đồng ý `git init` / commit nếu được hỏi |
| 1. Tự tìm hiểu dự án | Đọc README, CLAUDE.md, manifest, test, lịch sử git, plugin đã cài, memory cũ (nếu có agentmemory) → tóm tắt 3–5 dòng | Sửa nếu tóm tắt sai |
| 2. Hỏi nhanh | Mô tả ngắn + 4 câu chọn: **quy mô**, **ưu tiên token**, **rủi ro**, **có làm nhiều phiên không** | Trả lời |
| 3. Gợi ý bộ công cụ | Đề xuất khung (nhẹ / agent-skills / superpowers đầy đủ / superpowers một phần) + ponytail, agentmemory, kèm lý do; báo cái nào chưa cài và lệnh cài | Chọn |
| 4. Chốt yêu cầu + chuẩn bị repo | Hỏi cho rõ bằng công cụ tương tác của khung đã chọn (brainstorming / interview-me…). Chia nhỏ nếu dự án lớn; đề xuất tạo/rút gọn `CLAUDE.md`; thêm bước dựng test nếu chưa có | Trả lời, đồng ý |
| 5. Ghi cấu hình | Chọn model + ngân sách theo mức token, tắt plugin không dùng cho các bước chạy ngầm, hiện bản tóm tắt | Xác nhận để chạy |
| 6. Chạy + báo cáo | Chạy pipeline trên nhánh `auto/<tên>`, báo kết quả; lưu bài học vào agentmemory nếu dùng | Duyệt plan (nếu chọn dừng sau plan) |

### Mức token

| Mức | Plan | Build | Review | Commit | Vòng sửa tối đa | Trần ngân sách/lượt* |
|---|---|---|---|---|---|---|
| Tiết kiệm | Sonnet 5 | Sonnet 5 | Haiku 4.5 | Haiku 4.5 | 1 | ~4,8 USD |
| Cân bằng | Opus 5 | Sonnet 5 | Sonnet 5 | Haiku 4.5 | 2 | ~11,5 USD |
| Chất lượng | Opus 5 | Sonnet 5 | Opus 5 | Haiku 4.5 | 3 | ~19,5 USD |

\* Tổng trần của 4 bước, chưa tính vòng sửa (mỗi vòng thêm Build + Review). Đây là **mức tối đa**, chạy thật thường thấp hơn nhiều.

Ngoài chọn model, plugin tiết kiệm token bằng cách: tắt các plugin bạn không chọn trong các bước chạy ngầm (`disablePlugins`), giới hạn số skill mỗi bước, giữ `CLAUDE.md` ngắn, và đẩy phần hỏi đáp về phiên tương tác để các bước ngầm không phải đoán.

### Kết quả

| Mã thoát | Ý nghĩa |
|---|---|
| 0 | Đã commit (và push nếu bật) |
| 10 | Dừng sau plan → đọc `.pipeline/plan.md`, rồi chạy tiếp `--from build` |
| 2 | Review/test vẫn FAIL → xem `.pipeline/review.md`, không có gì được commit |
| 1 | Lỗi → xem `.pipeline/logs/` |

Chạy tiếp từ giữa: `--from build | review | commit`. Không bao giờ chạy trên `main`/`master`, không force-push.

## Cấu hình (`.pipeline/config.json`)

Claude tự ghi file này ở pha 5; bạn có thể sửa tay rồi chạy lại.

```json
{
  "project": "≤10 dòng: dự án là gì, stack, quy ước, ràng buộc",
  "task": "việc cần làm: kết quả, phạm vi, không làm gì, tiêu chí xong",
  "guidance": "Ponytail level: full. Terse output.",
  "branch": "auto/ten-nhanh",
  "testCmd": "npm test",
  "pauseAfterPlan": true,
  "maxFixLoops": 2,
  "push": false,
  "disablePlugins": ["superpowers@superpowers-marketplace"],
  "steps": {
    "plan":   { "model": "claude-opus-5",             "budgetUsd": 3,   "skills": ["planning-and-task-breakdown"] },
    "build":  { "model": "claude-sonnet-5",           "budgetUsd": 6,   "skills": ["test-driven-development", "ponytail:ponytail"] },
    "review": { "model": "claude-sonnet-5",           "budgetUsd": 2,   "skills": ["code-review-and-quality"] },
    "commit": { "model": "claude-haiku-4-5-20251001", "budgetUsd": 0.5, "skills": [] }
  }
}
```

| Trường | Ý nghĩa |
|---|---|
| `project` | Bối cảnh dự án, chỉ đưa vào bước Plan (plan.md mang tiếp cho các bước sau) |
| `guidance` | Một dòng chỉ dẫn đưa vào **mọi** bước |
| `disablePlugins` | Plugin (`tên@marketplace`) bị tắt trong các bước chạy ngầm, chỉ trong pipeline, không ảnh hưởng Claude Code bình thường của bạn |
| `skills` | Tên skill **đã cài trên máy bạn**. Không có cũng chạy được |

### Công cụ hỗ trợ (tuỳ chọn)

| Công cụ | Cài |
|---|---|
| [ponytail](https://github.com/DietrichGebert/ponytail) | `claude plugin marketplace add DietrichGebert/ponytail` → `claude plugin install ponytail@ponytail` |
| [superpowers](https://github.com/obra/superpowers) | `claude plugin marketplace add obra/superpowers-marketplace` → `claude plugin install superpowers@superpowers-marketplace` |
| [agent-skills](https://github.com/addyosmani/agent-skills) | `claude plugin marketplace add addyosmani/agent-skills` → `claude plugin install agent-skills@addy-agent-skills` |
| [agentmemory](https://github.com/rohitg00/agentmemory) | `claude plugin marketplace add rohitg00/agentmemory` → `claude plugin install agentmemory@agentmemory`, rồi chạy server `npx -y @agentmemory/agentmemory@latest` |

Không cài cái nào vẫn dùng được (khung "Nhẹ"). Pha 3 sẽ hỏi trước khi cài giúp bạn.

## Lưu ý

- **Tốn tiền API thật.** `budgetUsd` là trần cho mỗi bước; xem bảng Mức token ở trên.
- Bước Build được chạy lệnh shell (trừ commit/push/reset/đổi nhánh). Chỉ chạy trên repo bạn tin tưởng.
- Nên để `pauseAfterPlan: true` vài lần đầu để đọc plan trước khi code.
- Đang ở bản thử nghiệm (0.2.0): đã test trọn vẹn với Haiku; chưa test đầy đủ với Opus/Sonnet và nhánh push.

## Giấy phép

MIT
