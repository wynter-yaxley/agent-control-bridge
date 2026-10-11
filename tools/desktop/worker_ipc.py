#!/usr/bin/env python3
"""Authenticated desktop IPC worker.

从 stdin 读一个 JSON 请求，验证一次性能力凭证（签名/过期/绑定/一次性），
分发到对应桌面写操作，stdout 输出结构化 JSON 响应。所有失败 fail-closed。

请求格式（一行 JSON）：
{
  "requestId": "uuid",           # 每次调用唯一，用于响应关联
  "operation": "codex_send" | "gpt_send" | "check_cdp",
  "capability": "<token>",       # 一次性能力凭证（HMAC 签名）
  "binding": "<binding string>", # 与凭证签发的 binding 必须一致
  "prompt": "...",               # 写操作的文本
  "targetContext": {...},        # codex_send/gpt_send 的 target_context
  "forceClear": false
}

响应（stdout，JSON）：{ "requestId": ..., "status": "success"|"error",
  "code": ..., "exitCode": ..., "details": {...} }

信任边界：本 Worker 不信任请求 JSON 的字段或调用者自报身份；只信任经过
HMAC 验证且未过期、未重放的能力凭证。凭证只由可信宿主（Node）签发。
"""
import contextlib
import hashlib
import io
import json
import sys

from capability import NonceStore, verify
from desktop_common import ToolError, targets
from desktop_guards import binding_fingerprint


class CapabilityAuthority:
    """从已验证能力凭证构造的一次性授权，替代内存 DesktopAuthority 跨进程传递。

    grants: {operation: (prompt_hash, binding)}。每个 operation 只能被消费一次。
    """

    def __init__(self, grants):
        self._grants = grants
        self._consumed = set()

    def consume(self, handle, operation, prompt_hash=None, binding=None):
        expected = self._grants.get(operation)
        if expected is None or operation in self._consumed or expected != (prompt_hash, binding):
            raise ToolError('AUTH', 'One-time trusted host approval required')
        self._consumed.add(operation)


def _require(request, field):
    value = request.get(field)
    if value is None:
        raise ToolError('INPUT', f'IPC request requires {field}', 2)
    return value


def _capability_authority(operation, payload, prompt, target_context):
    """构造 CapabilityAuthority：把凭证携带的 promptHash/binding 与请求对齐。"""
    prompt = prompt or ''
    digest = hashlib.sha256(prompt.encode('utf-8')).hexdigest() if prompt else None
    if payload.get('promptHash') is not None:
        if digest is None or payload['promptHash'] != digest:
            raise ToolError('AUTH', 'Capability promptHash does not match the request prompt', 2)
    ctx = target_context if isinstance(target_context, dict) else {}
    fingerprint = binding_fingerprint(ctx) if ctx else None
    if operation == 'codex_send':
        return CapabilityAuthority({
            'codex_send_cdp.py': (digest, fingerprint),
            'verified-chatgpt-prompt': (digest, None),
        })
    if operation == 'gpt_send':
        return CapabilityAuthority({
            'gpt_send_cdp.py': (digest, fingerprint),
            'verified-chatgpt-prompt': (digest, None),
        })
    raise ToolError('INPUT', f'Unsupported IPC operation: {operation}', 2)


def _dispatch(operation, request, authority):
    """把已验证请求分发到对应工具，返回 (exit_code, result_dict)。"""
    prompt = request.get('prompt') or ''
    target_context = request.get('targetContext') or {}
    force_clear = bool(request.get('forceClear'))
    # 隔离桌面工具自身的 stdout 输出：工具成功时会 print JSON，若直接写进
    # Worker 的 stdout 会与 Worker 响应 JSON 拼接，使 Node 端 JSON.parse 失败
    # （成功投递被误报失败 → 重复投递风险）。这里捕获并解析为结构化结果。
    captured = io.StringIO()
    with contextlib.redirect_stdout(captured):
        if operation == 'codex_send':
            import codex_send_cdp
            argv = ['codex-send']
            if force_clear:
                argv.append('--force-clear')
            argv.append('--')  # 分隔符：之后的 prompt 原样作为正文，避免前缀被吞为选项
            argv.append(prompt)
            sys.argv = argv
            exit_code = codex_send_cdp.main(
                authority=authority,
                approval='ipc-grant',
                bridge_receipt='ipc-receipt',
                target_context=target_context,
            )
        elif operation == 'gpt_send':
            import gpt_send_cdp
            argv = ['gpt-send']
            if force_clear:
                argv.append('--force-clear')
            argv.append('--')
            argv.append(prompt)
            sys.argv = argv
            exit_code = gpt_send_cdp.main(
                authority=authority,
                approval='ipc-grant',
                bridge_receipt='ipc-receipt',
                target_context=target_context,
            )
        else:
            raise ToolError('INPUT', f'Unsupported IPC operation: {operation}', 2)
    # 解析工具的结构化输出，把关键结果（status/submissionVerified 等）透传给 Node
    tool_output = captured.getvalue().strip()
    details = {}
    try:
        parsed = json.loads(tool_output)
        if isinstance(parsed, dict):
            details = parsed
    except (ValueError, AttributeError):
        if tool_output:
            details = {'toolStdout': tool_output[:1024]}
    return exit_code or 0, {'operation': operation, **details}


def handle(request):
    """处理一个已验证的 IPC 请求。返回 (exit_code, result_dict)。"""
    request_id = _require(request, 'requestId')
    operation = _require(request, 'operation')
    capability = _require(request, 'capability')
    binding = _require(request, 'binding')

    if operation == 'check_cdp':
        # 只读健康检查（仅返回 CDP 可达性与 target 数量），不改任何状态；
        # 仅能由本机可信 Node spawn（stdin 不可被外部触达），故不要求能力凭证。
        if sys.platform != 'win32':
            raise ToolError('DEPENDENCY', 'Use Windows-side Python; WSL loopback may be a different network namespace', 6)
        available = targets()
        return 0, {'cdpReachable': True, 'targetCount': len(available), 'modelVerified': False}

    # 验证凭证（签名/过期/operation/binding）
    payload = verify(capability, operation, binding)
    # 原子消费 nonce（防重放）：任何重放请求在此拒绝
    NonceStore().consume(payload['nonce'])
    # 验证 forceClear 与凭证一致（防篡改 composer 清空行为）
    if bool(request.get('forceClear')) != bool(payload.get('forceClear')):
        raise ToolError('AUTH', 'Capability forceClear does not match the request', 2)
    target_context = request.get('targetContext') or {}
    # 交叉核验：凭证签发的 conversationId/workspace 若非 null，必须与请求的 targetContext 一致
    if payload.get('conversationId') is not None and target_context.get('conversationId') is not None and payload['conversationId'] != target_context['conversationId']:
        raise ToolError('AUTH', 'Capability conversationId does not match the target context', 2)
    if payload.get('workspace') is not None and target_context.get('workspacePath') is not None and payload['workspace'] != target_context['workspacePath']:
        raise ToolError('AUTH', 'Capability workspace does not match the target context', 2)
    prompt = request.get('prompt') or ''
    authority = _capability_authority(operation, payload, prompt, target_context)
    exit_code, result = _dispatch(operation, request, authority)
    result['requestId'] = request_id
    return exit_code, result


def main():
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({'status': 'error', 'code': 'INPUT', 'message': 'Empty IPC request'}, ensure_ascii=False))
        return 2
    try:
        request = json.loads(raw)
    except ValueError:
        print(json.dumps({'status': 'error', 'code': 'INPUT', 'message': 'Malformed IPC request JSON'}, ensure_ascii=False))
        return 2
    if not isinstance(request, dict):
        print(json.dumps({'status': 'error', 'code': 'INPUT', 'message': 'IPC request must be a JSON object'}, ensure_ascii=False))
        return 2
    try:
        exit_code, result = handle(request)
        # 非零退出码（如 submission_unverified）必须返回 error 状态，不能自报 success
        status = 'success' if exit_code == 0 else 'error'
        print(json.dumps({'status': status, **result}, ensure_ascii=False))
        return exit_code
    except ToolError as error:
        print(json.dumps({'status': 'error', 'code': error.code, 'message': error.message,
                          'requestId': request.get('requestId'), 'details': error.details}, ensure_ascii=False))
        return error.exit_code
    except Exception:
        print(json.dumps({'status': 'error', 'code': 'INTERNAL', 'message': 'Worker failed closed',
                          'requestId': request.get('requestId')}, ensure_ascii=False))
        return 3


if __name__ == '__main__':
    sys.exit(main())
