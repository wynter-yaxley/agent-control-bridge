#!/usr/bin/env python3
"""Read-only desktop evidence probe. It never grants authority or sends text."""
import argparse
import json
import sys

from desktop_common import Cdp, ToolError, entry, find_target
from desktop_guards import classify_execution_target, read_execution_environment, read_project_route


def main():
    parser=argparse.ArgumentParser(description='Read-only route and execution evidence classification; observations are not authority')
    parser.add_argument('kind',choices=['gpt','codex'])
    args=parser.parse_args()
    connection=Cdp(find_target('webview' if args.kind=='gpt' else 'page'))
    try:
        route=read_project_route(connection)
        execution=read_execution_environment(connection)
    finally:
        connection.close()
    route_status='unknown'
    if route:
        route_status='assigned' if route.get('projectId') else ('recent-unassigned' if route.get('listKind')=='recent' else 'unassigned')
    print(json.dumps({'status':'observed','kind':args.kind,'routeOwnership':route_status,
                      'conversationIdentityObserved':bool(route and route.get('conversationId')),
                      'workspacePathObserved':bool(route and route.get('workspacePath')),
                      'execution':classify_execution_target(execution),
                      'trustedAuthorityGranted':False},ensure_ascii=False))
    return 0


if __name__=='__main__': sys.exit(entry(main))
