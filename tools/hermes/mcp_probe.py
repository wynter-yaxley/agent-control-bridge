#!/usr/bin/env python3
"""Probe installed Hermes MCP SDK against an isolated compiled bridge.

No gateway, model, event consumer, credential file, or production policy is
loaded. Temporary policy/database belong exclusively to this probe.
"""
import argparse
import asyncio
import importlib.metadata
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

phase = 'preflight'


async def probe(root, node, timeout):
    global phase
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
    params = StdioServerParameters(
        command=node, args=[str(root / 'dist/mcp.js'), '--db', str(root / 'data/probe.sqlite')],
        cwd=str(root), env={'PATH': str(Path(node).parent), 'HOME': str(root)},
    )
    with open(os.devnull, 'w') as diagnostics:
        async with stdio_client(params, errlog=diagnostics) as (reader, writer):
            async with ClientSession(reader, writer, read_timeout_seconds=timeout) as session:
                phase = 'initialize'
                initialization = await session.initialize()
                phase = 'tools'
                names = {tool.name for tool in (await session.list_tools()).tools}
                if not {'acb_capabilities', 'acb_project_prepare', 'acb_project_reconcile', 'acb_notifications_pull', 'acb_native_target_check'}.issubset(names):
                    raise ValueError('TOOLS')
                phase = 'capabilities'
                capability = await session.call_tool('acb_capabilities', {})
                facts = json.loads(capability.content[0].text)
                if facts['fullWorkflowReady'] or 'ORDINARY_CHAT_HOST_MISSING' not in facts['blockers']:
                    raise ValueError('CAPABILITIES')
                phase = 'project'
                prepared = await session.call_tool('acb_project_prepare', {'name': '隔离互通项目', 'eventKey': 'isolated-probe-event'})
                operation = json.loads(prepared.content[0].text)
                if getattr(prepared, 'is_error', getattr(prepared, 'isError', False)) or operation['state'] != 'BLOCKED':
                    raise ValueError('PROJECT')
                phase = 'dedupe'
                replay = await session.call_tool('acb_project_prepare', {'name': '隔离互通项目', 'eventKey': 'isolated-probe-event'})
                if json.loads(replay.content[0].text)['id'] != operation['id']:
                    raise ValueError('DEDUPE')
                phase = 'project_reconcile'
                reconcile = await session.call_tool('acb_project_reconcile', {'operationId': operation['id']})
                if not getattr(reconcile, 'is_error', getattr(reconcile, 'isError', False)) or json.loads(reconcile.content[0].text)['code'] != 'STATE':
                    raise ValueError('RECONCILE')
                phase = 'authorization'
                denied = await session.call_tool('acb_review_submit', {'taskId': 'isolated-nonexistent', 'expectedVersion': 0, 'pass': True})
                if not getattr(denied, 'is_error', getattr(denied, 'isError', False)):
                    raise ValueError('AUTH')
                phase = 'native_scope'
                native_denied = await session.call_tool('acb_native_target_check', {'projectId': 'isolated-unregistered', 'conversationId': 'isolated-unregistered'})
                if not getattr(native_denied, 'is_error', getattr(native_denied, 'isError', False)) or json.loads(native_denied.content[0].text)['code'] != 'AUTH':
                    raise ValueError('NATIVE_SCOPE')
                phase = 'completed'
                return {'ok': True, 'mcpSdk': importlib.metadata.version('mcp'),
                        'negotiatedProtocol': getattr(initialization, 'protocol_version', getattr(initialization, 'protocolVersion', None)), 'tools': len(names),
                        'sameEventDeduplicated': True, 'ordinaryChatBlockObserved': True,
                        'reviewerAuthorizationDenied': True, 'productionConfigModified': False,
                        'unregisteredNativeTargetDenied': True,
                        'unreadyReconciliationDenied': True,
                        'realAgentInvoked': False, 'liveMessageReceived': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--node', required=True)
    parser.add_argument('--repository', required=True)
    parser.add_argument('--timeout', type=int, default=30)
    args = parser.parse_args()
    if os.name != 'posix' or not 1 <= args.timeout <= 120:
        raise ValueError('PLATFORM_OR_BUDGET')
    repository = Path(args.repository).resolve()
    if not (repository / 'dist/mcp.js').is_file():
        raise ValueError('BUILD_REQUIRED')
    with tempfile.TemporaryDirectory(prefix='acb-hermes-mcp-probe-') as temporary:
        root = Path(temporary)
        shutil.copytree(repository / 'dist', root / 'dist')
        shutil.copyfile(repository / 'package.json', root / 'package.json')
        (root / 'node_modules').symlink_to(repository / 'node_modules', target_is_directory=True)
        (root / 'config').mkdir(mode=0o700)
        (root / 'config/caller-policy.json').write_text(json.dumps([{
            'principal': f'uid:{os.getuid()}', 'instance': 'isolated-hermes-probe',
            'executor': 'hermes', 'controller': True, 'reviewer': False,
        }]), encoding='utf8')
        os.chmod(root / 'config/caller-policy.json', 0o600)
        result = asyncio.run(asyncio.wait_for(probe(root, args.node, args.timeout), args.timeout + 5))
    result['temporaryResourcesRemoved'] = not root.exists()
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except Exception:
        # SDK failures can contain external payloads. Keep diagnostics fixed.
        print(json.dumps({'ok': False, 'code': 'PROBE_FAILED', 'phase': phase, 'privateDiagnosticsOmitted': True}))
        sys.exit(1)
