#!/usr/bin/env bash
# dsh-headless-shim.sh — 让 `dsh headless "任务"` 走 dsh-web-submit(POST /x/headless)
#
# 为什么需要它
#   插件只提供 HTTP 端点;`dsh headless` 这个命令本身由 dsh 的 CLI 层解析,
#   在插件加载之前就决定了要起一个独立进程 —— 插件无权改变这一点。
#   把本脚本装成 PATH 里靠前的 `dsh`,即可保持命令行形式不变,而任务改在
#   正在运行的 dsh web 进程内执行:Web UI 侧栏可见、实时流、自动归组、
#   并等到 turn/end 才退出(可当同步调用)。
#
# 安装(用户自己决定,不是 dsh plugin 能自动完成的):
#   install -m 0755 headless-shim.sh ~/.local/bin/dsh
#   # 确保 ~/.local/bin 在 PATH 中先于真正的 dsh(~/.npm-global/bin 等)
#   # 验证:type -a dsh   → 第一个应是 ~/.local/bin/dsh
#
# 不要覆盖系统级 dsh:systemd/服务单元通常用绝对路径启动,本来就不经过本脚本。
# 卸载:rm ~/.local/bin/dsh
#
# 透传规则
#   - 非 headless 子命令(`dsh web`、`dsh plugin ...` 等)一律原样交给真实 dsh
#   - `--json` / `--session-id` / `-h` / `--help`:插件无法等价支持,原样回退 CLI
#   - 未知选项:原样回退 CLI(保守,绝不猜你的意图)
#   - `dsh headless "任务"` / `dsh --profile headless "任务"` / stdin(`-` 或管道)→ 插件
#
# 支持的任务级选项(仅本脚本识别,不会传给真实 CLI):
#   -C, --cwd <dir>            任务工作目录(也是沙箱写边界),默认 $PWD
#       --preset <name>        agent 预设名,默认用 profile 默认预设
#       --permission <name>    权限预设,无人值守必给(或插件配 defaultPermission)
#       --provider <id>        供应商 id(需与 --model 同时给)
#       --model <id>           模型 id
#       --effort <level>       reasoningEffort: off|low|medium|high|max
#       --timeout <seconds>    等待 turn/end 的上限,默认 3600
#
# 环境变量
#   DSH_WEB_SUBMIT_URL   插件基地址,默认 http://127.0.0.1:3080
#   DSH_HEADLESS_CWD     提交用的 cwd,默认当前目录(选项 -C 优先)
#   DSH_HEADLESS_TIMEOUT 等待上限秒数,默认 3600(--timeout 优先)
#   DSH_HEADLESS_CLI     真实 dsh 可执行路径,默认自动探测
#
# 退出码:0 = turn/end 且 reason.kind=completed;1 = 失败/被中止/超时/提交被拒。
# stdout 只放最终答案,便于 `out=$(dsh headless ...)` 直接当 CLI 用。

set -uo pipefail

BASE="${DSH_WEB_SUBMIT_URL:-http://127.0.0.1:3080}"

fail() { echo "dsh: headless shim: $*" >&2; exit 1; }

# 诊断信息只留一行一小段:后端可能回整页 HTML
brief() { printf '%s' "$1" | tr '\n\r' '  ' | cut -c1-300; }

# ---- 找到真实 dsh(必须排除自己,否则 exec 自身会无限递归)----
self_path="$(cd "$(dirname "$0")" 2>/dev/null && pwd -P)/$(basename "$0")"
same_as_self() {
  local cand_abs
  cand_abs="$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/$(basename "$1")" || return 1
  [ "$cand_abs" = "$self_path" ]
}

REAL_DSH=""
if [ -n "${DSH_HEADLESS_CLI:-}" ]; then
  [ -x "$DSH_HEADLESS_CLI" ] || fail "DSH_HEADLESS_CLI is not executable: $DSH_HEADLESS_CLI"
  same_as_self "$DSH_HEADLESS_CLI" && fail "DSH_HEADLESS_CLI points at this shim itself: $DSH_HEADLESS_CLI"
  REAL_DSH="$DSH_HEADLESS_CLI"
else
  for cand in "$HOME/.npm-global/bin/dsh" "/usr/local/bin/dsh" "/opt/homebrew/bin/dsh" "/usr/bin/dsh"; do
    [ -x "$cand" ] || continue
    same_as_self "$cand" && continue
    REAL_DSH="$cand"; break
  done
  if [ -z "$REAL_DSH" ]; then
    cand="$(command -v dsh 2>/dev/null || true)"
    if [ -n "$cand" ] && ! same_as_self "$cand"; then REAL_DSH="$cand"; fi
  fi
fi

orig=("$@")

# ---- 判断是否 headless 调用 ----
headless=0
args=()
if [ "${1:-}" = "headless" ]; then
  headless=1; shift; args=("$@")
elif [ "${1:-}" = "--profile" ] && [ "${2:-}" = "headless" ]; then
  headless=1; shift 2; args=("$@")
fi

pass_through() {
  [ -n "$REAL_DSH" ] || fail "real dsh not found; set DSH_HEADLESS_CLI=/path/to/dsh"
  exec "$REAL_DSH" "${orig[@]}"
}

[ "$headless" -eq 1 ] || pass_through

# ---- 插件无法等价支持的形态:回退真实 CLI ----
for a in "${args[@]:-}"; do
  case "$a" in
    --json|--json=*|--session-id|--session-id=*|-h|--help) pass_through ;;
  esac
done

# ---- 解析任务级选项 ----
cwd="${DSH_HEADLESS_CWD:-$PWD}"
preset=""; permission=""; provider=""; model=""; effort=""
timeout="${DSH_HEADLESS_TIMEOUT:-3600}"
words=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; words+=("$@"); break ;;
    -C|--cwd)         [ "$#" -ge 2 ] || fail "$1 needs a value"; cwd="$2"; shift 2 ;;
    --preset)         [ "$#" -ge 2 ] || fail "$1 needs a value"; preset="$2"; shift 2 ;;
    --permission)     [ "$#" -ge 2 ] || fail "$1 needs a value"; permission="$2"; shift 2 ;;
    --provider)       [ "$#" -ge 2 ] || fail "$1 needs a value"; provider="$2"; shift 2 ;;
    --model)          [ "$#" -ge 2 ] || fail "$1 needs a value"; model="$2"; shift 2 ;;
    --effort|--reasoning-effort) [ "$#" -ge 2 ] || fail "$1 needs a value"; effort="$2"; shift 2 ;;
    --timeout)        [ "$#" -ge 2 ] || fail "$1 needs a value"; timeout="$2"; shift 2 ;;
    -)                words+=("$(cat)"); shift ;;
    -*)               pass_through ;;
    *)                words+=("$1"); shift ;;
  esac
done

task=""
for w in "${words[@]:-}"; do
  task="${task:+$task }$w"
done
if [ -z "${task//[[:space:]]/}" ] && [ ! -t 0 ]; then
  task="$(cat)"
fi
[ -n "${task//[[:space:]]/}" ] || fail "empty task"

# ---- 模型字段:插件要求 provider 与 model 同时给 ----
if [ -n "$effort" ] && { [ -z "$provider" ] || [ -z "$model" ]; }; then
  fail "--effort requires --provider and --model"
fi
if [ -n "$provider" ] && [ -z "$model" ]; then fail "--provider requires --model"; fi
if [ -n "$model" ] && [ -z "$provider" ]; then fail "--model requires --provider"; fi

# 插件可用性:200 = 可用;404 = 老版本插件(没有 /health)仍然可能可用,
# 交给提交结果判定;其它(含连接失败)= 不可用,直接回退。
plugin_state() {
  local code
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "$BASE/x/headless/health" 2>/dev/null || echo 000)"
  case "$code" in
    200) echo ok ;;
    404) echo unknown ;;
    *) echo down ;;
  esac
}

fallback() {
  [ -n "$REAL_DSH" ] || fail "plugin unavailable ($1) and real dsh not found"
  echo "dsh: headless shim: plugin unavailable ($1); falling back to dsh headless CLI" >&2
  exec "$REAL_DSH" "${orig[@]}"
}

state="$(plugin_state)"
[ "$state" = "down" ] && fallback "health check failed"

# ---- 提交 ----
payload="$(TASK="$task" CWD="$cwd" PRESET="$preset" PERMISSION="$permission" \
  PROVIDER="$provider" MODEL="$model" EFFORT="$effort" python3 - <<'PY'
import json, os
body = {"task": os.environ["TASK"], "cwd": os.environ["CWD"]}
for key, env in (("preset", "PRESET"), ("permission", "PERMISSION"),
                 ("provider", "PROVIDER"), ("model", "MODEL"),
                 ("reasoningEffort", "EFFORT")):
    value = os.environ.get(env, "")
    if value:
        body[key] = value
print(json.dumps(body))
PY
)" || fail "cannot build payload"

resp="$(curl -sS --max-time 60 -X POST "$BASE/x/headless" \
  -H 'content-type: application/json' --data-binary "$payload" 2>/dev/null)" || fallback "submit transport error"
[ -n "$resp" ] || fallback "empty submit response"

sid="$(printf '%s' "$resp" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); raise SystemExit
print(d.get("sessionId","") if d.get("ok") else "")
' 2>/dev/null)"
[ -n "$sid" ] || {
  # 旧版插件(无 health)无法预先判断,提交被拒就说明它不可用 → 回退 CLI
  [ "$state" = "unknown" ] && fallback "submit rejected: $(brief "$resp")"
  fail "submit rejected: $(brief "$resp")"
}
echo "dsh: headless shim: sessionId=$sid (visible in the dsh Web UI)" >&2

# ---- 等待 turn/end,把最终 assistant 文本打到 stdout(保持 CLI 的输出契约)----
BASE="$BASE" SID="$sid" TIMEOUT="$timeout" exec python3 - <<'PY'
import json, os, sys, time, urllib.request

base = os.environ["BASE"].rstrip("/")
sid = os.environ["SID"]
deadline = time.time() + float(os.environ.get("TIMEOUT") or 3600)
last_text = ""
while time.time() < deadline:
    try:
        with urllib.request.urlopen(
            base + "/x/headless/status?sessionId=" + sid, timeout=15
        ) as r:
            data = json.load(r)
    except Exception:
        time.sleep(2)
        continue
    events = data.get("events") or []
    reason = None
    for e in events:
        kind = e.get("type")
        if kind == "assistant/message":
            msg = (e.get("data") or {}).get("message") or {}
            text = "".join(
                p.get("text", "") for p in (msg.get("content") or [])
                if p.get("type") == "text"
            )
            if text.strip():
                last_text = text
        elif kind == "turn/end":
            reason = ((e.get("data") or {}).get("reason") or {}).get("kind")
    if reason is not None:
        if last_text:
            print(last_text)
        sys.exit(0 if reason == "completed" else 1)
    time.sleep(2)
print("dsh: headless shim: timeout waiting for turn/end", file=sys.stderr)
sys.exit(1)
PY
