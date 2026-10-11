#!/usr/bin/env python3
"""One-shot capability credentials for authenticated desktop IPC.

信任边界：凭证只能由可信宿主（Node）用共享密钥签发；Python Worker 只验证
HMAC 签名、过期、operation/binding 匹配与一次性 nonce，绝不信任 JSON 字段
或调用者自报身份。凭证不落日志、命令行、Git 或持久化配置。

关键安全边界：一次性能力凭证只能由桥接系统新生成，禁止读取或复用任何
应用现有 Cookie、Token、密码或登录凭证。
"""
import base64
import hashlib
import hmac
import json
import os
import time
import uuid

from desktop_common import ToolError

MAX_TOKEN_LENGTH = 4096
DEFAULT_TTL_SECONDS = 60
MIN_SECRET_LENGTH = 32
MAX_CONSUMED_NONCES = 100000


def _secret(secret=None):
    if secret is None:
        secret = os.environ.get('ACB_IPC_SECRET')
    if not secret or not isinstance(secret, str) or len(secret) < MIN_SECRET_LENGTH:
        raise ToolError('IPC_CONFIG', 'ACB_IPC_SECRET must be a >=32 char shared secret', 2)
    return secret


def _required(payload, field):
    value = payload.get(field)
    if value is None:
        raise ToolError('AUTH', f'Capability missing required field: {field}', 2)
    return value


def issue(payload, secret=None, ttl_seconds=DEFAULT_TTL_SECONDS):
    """签发一次性能力凭证，返回 '<urlsafe-b64 body>.<hex sig>'。

    payload 必须含 operation 与 binding；binding 是把本次授权绑定到
    具体 task/conversation/workspace/promptHash 的规范化字符串。
    """
    secret = _secret(secret)
    if not isinstance(payload, dict) or not payload.get('operation') or not isinstance(payload.get('binding'), str) or not payload['binding'].strip():
        raise ToolError('INPUT', 'Capability requires a non-empty operation and binding', 2)
    body = {
        'operation': payload['operation'],
        'binding': payload['binding'],
        'taskId': payload.get('taskId'),
        'conversationId': payload.get('conversationId'),
        'workspace': payload.get('workspace'),
        'promptHash': payload.get('promptHash'),
        'forceClear': bool(payload.get('forceClear', False)),
        'nonce': uuid.uuid4().hex,
        'expiresAt': int(time.time()) + int(ttl_seconds),
    }
    data = json.dumps(body, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode('utf-8')
    sig = hmac.new(secret.encode('utf-8'), data, hashlib.sha256).hexdigest()
    return base64.urlsafe_b64encode(data).decode().rstrip('=') + '.' + sig


def verify(token, expected_operation, expected_binding, secret=None):
    """验证凭证签名、过期、operation、binding；返回 payload（含 nonce），失败抛 ToolError。"""
    secret = _secret(secret)
    if not isinstance(token, str) or len(token) > MAX_TOKEN_LENGTH or token.count('.') != 1:
        raise ToolError('AUTH', 'Malformed capability token', 2)
    encoded, sig = token.split('.', 1)
    try:
        data = base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4))
    except Exception:
        raise ToolError('AUTH', 'Malformed capability token encoding', 2)
    if not hmac.compare_digest(hmac.new(secret.encode('utf-8'), data, hashlib.sha256).hexdigest(), sig):
        raise ToolError('AUTH', 'Capability signature verification failed', 2)
    try:
        payload = json.loads(data)
    except Exception:
        raise ToolError('AUTH', 'Malformed capability payload', 2)
    if not isinstance(payload, dict):
        raise ToolError('AUTH', 'Malformed capability payload', 2)
    if payload.get('operation') != expected_operation:
        raise ToolError('AUTH', 'Capability operation mismatch', 2)
    if payload.get('binding') != expected_binding:
        raise ToolError('AUTH', 'Capability binding mismatch', 2)
    if not payload.get('expiresAt') or int(payload['expiresAt']) < int(time.time()):
        raise ToolError('AUTH', 'Capability expired', 2)
    if not isinstance(payload.get('nonce'), str) or not payload['nonce']:
        raise ToolError('AUTH', 'Capability nonce missing', 2)
    return payload


def _flock_exclusive(lock_file):
    if os.name == 'nt':
        import msvcrt
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_LOCK, 1)
    else:
        import fcntl
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_EX)


def _funlock(lock_file):
    if os.name == 'nt':
        import msvcrt
        lock_file.seek(0)
        msvcrt.locking(lock_file.fileno(), msvcrt.LK_UNLCK, 1)
    else:
        import fcntl
        fcntl.flock(lock_file.fileno(), fcntl.LOCK_UN)


class NonceStore:
    """跨进程一次性 nonce 消费记录，用文件锁实现原子消费（防重放）。

    消费记录持久化到受控文件，避免 Worker 每次调用都是新进程时重放。
    """

    def __init__(self, path=None):
        if path is None:
            base = os.environ.get('ACB_NONCE_STORE') or os.path.join(
                os.path.expanduser('~'), '.acb', 'consumed-nonces.json')
            path = base
        self.path = path
        self._lock_path = path + '.lock'

    def _read(self):
        if not os.path.exists(self.path):
            return []
        try:
            with open(self.path, 'r', encoding='utf-8') as f:
                value = json.load(f)
        except (OSError, ValueError):
            # 文件存在但读取/解析失败：fail-closed（拒绝消费，宁可阻断桌面操作）
            raise ToolError('IPC_STATE', 'Nonce store is unreadable or corrupted; refusing to consume', 6)
        if not isinstance(value, list):
            raise ToolError('IPC_STATE', 'Nonce store is malformed; refusing to consume', 6)
        return value

    def _write(self, nonces):
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(nonces, f, separators=(',', ':'))
        os.replace(tmp, self.path)

    def consume(self, nonce):
        if not isinstance(nonce, str) or not nonce or len(nonce) > 256:
            raise ToolError('AUTH', 'Capability nonce missing', 2)
        directory = os.path.dirname(self.path) or '.'
        os.makedirs(directory, exist_ok=True)
        lock = open(self._lock_path, 'a+')
        try:
            _flock_exclusive(lock)
            consumed = self._read()
            if nonce in consumed:
                raise ToolError('AUTH', 'Capability already consumed (replay refused)', 2)
            if len(consumed) >= MAX_CONSUMED_NONCES:
                consumed = consumed[-MAX_CONSUMED_NONCES // 2:]
            consumed.append(nonce)
            self._write(consumed)
        finally:
            try:
                _funlock(lock)
            finally:
                lock.close()
