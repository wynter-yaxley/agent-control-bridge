"""Fail-closed project routing and local Codex execution checks.

Bridge mappings are expected intent. CDP snapshots and Codex state files are
application observations; neither is promoted to cryptographic authority.
"""
import json
import ntpath
import os
import re
from pathlib import Path

from desktop_common import ToolError, guard_write, STATE_FILE_MAX_BYTES, MAX_PATH_ROOTS


def canonical_path(value):
    if not isinstance(value, str) or not value.strip() or '\x00' in value:
        return None
    if re.match(r'^[A-Za-z]:[\\/]', value) or value.startswith('\\\\'):
        # Windows 路径：realpath 解析 junction/symlink/8.3 短名，再 normcase 统一大小写
        try:
            resolved = os.path.realpath(value)
        except (OSError, ValueError):
            return None
        return ntpath.normcase(ntpath.normpath(resolved))
    return os.path.normcase(os.path.realpath(os.path.expanduser(value)))


def _mapping_problem(expected, provider=None):
    if not isinstance(expected, dict):
        return 'Expected bridge mapping is missing'
    if expected.get('mappingSource') != 'bridge-registry' or expected.get('registered') is not True:
        return 'Expected target must come from the registered bridge mapping'
    if expected.get('provider') not in ('gpt','codex'):
        return 'Registered target provider is missing or ambiguous'
    if provider and expected.get('provider') != provider:
        return 'Registered target provider does not match the requested operation'
    if not isinstance(expected.get('conversationId'), str) or not expected['conversationId'].strip():
        return 'Registered conversation identity is missing'
    project_id = expected.get('projectId')
    workspace = expected.get('workspacePath')
    root = expected.get('projectRoot')
    if project_id is None:
        if workspace is not None or root is not None:
            return 'Non-project conversation contains project/workspace metadata'
        return None
    if not isinstance(project_id, str) or not project_id.strip():
        return 'Project identity is ambiguous'
    if canonical_path(workspace) is None or canonical_path(root) is None:
        return 'Project workspace mapping is incomplete'
    if canonical_path(workspace) != canonical_path(root):
        return 'Workspace path does not match the registered project root'
    return None


def binding_fingerprint(expected):
    """Stable, non-secret binding to place in a host-issued one-time approval."""
    fields = {key: expected.get(key) for key in
              ('mappingSource', 'registered', 'provider', 'projectId', 'workspacePath', 'projectRoot', 'conversationId')}
    return json.dumps(fields, sort_keys=True, separators=(',', ':'), ensure_ascii=False)


def _snapshot(connection, expression):
    try:
        value=connection.evaluate(expression)
        if isinstance(value,str): value=json.loads(value)
        if not isinstance(value,dict) or value.get('ambiguous') is True:
            return None
        return value
    except Exception:
        return None


def read_project_route(connection):
    return _snapshot(connection, ROUTE_SNAPSHOT_JS)


def read_execution_environment(connection):
    return _snapshot(connection, EXECUTION_SNAPSHOT_JS)


def repair_project_route(connection, expected, evidence, authority, approval):
    """Use only an explicit data-ID based move affordance, then read the app again."""
    if not isinstance(evidence,dict) or evidence.get('moveAction') != {
            'supported':True,'conversationId':expected.get('conversationId')}:
        return None
    try:
        guard_write('project_route_repair',authority,approval,binding=binding_fingerprint(expected))
    except ToolError:
        raise
    payload=json.dumps({'conversationId':expected['conversationId']},separators=(',',':'))
    expression=r"""/* ACB_PROJECT_REPAIR_OPEN */
    (()=>{const target=%s;
      const rows=[...document.querySelectorAll('[data-conversation-id]')].filter(e=>e.dataset.conversationId===target.conversationId&&e.offsetParent!==null);
      if(rows.length!==1)return 'target-ambiguous';
      const moves=[...rows[0].querySelectorAll('[data-action="move-to-project"]')].filter(e=>e.offsetParent!==null);
      if(moves.length!==1)return 'move-unsupported';
      moves[0].click();return 'menu-opened';})()
    """ % payload
    try: result=connection.evaluate(expression)
    except Exception: return None
    if result!='menu-opened': return None
    option_payload=json.dumps({'projectId':expected['projectId']},separators=(',',':'))
    option_script=r"""/* ACB_PROJECT_REPAIR_SELECT */
    (()=>{const target=%s;
      const options=[...document.querySelectorAll('[role="menuitem"][data-project-id], [data-action="assign-project"][data-project-id]')]
        .filter(e=>e.offsetParent!==null&&e.dataset.projectId===target.projectId);
      if(options.length>1)return 'ambiguous';if(!options.length)return 'waiting';options[0].click();return 'move-requested';})()
    """ % option_payload
    # Poll for an application-side ownership change, bounded and state-driven.
    import time
    deadline=time.monotonic()+1.0
    while True:
        try: selected=connection.evaluate(option_script)
        except Exception: return None
        if selected=='ambiguous': return None
        if selected=='move-requested': break
        if time.monotonic()>=deadline: return None
        time.sleep(0.05)
    deadline=time.monotonic()+1.0
    while True:
        current=read_project_route(connection)
        if current and current.get('conversationId')==expected.get('conversationId') and current.get('projectId')==expected.get('projectId'):
            return current
        if time.monotonic()>=deadline: return current
        time.sleep(0.05)


def guard_project_route(expected, evidence, repair=None, provider=None):
    """Compare bridge intent with app-observed ownership; optionally repair and re-read.

    `repair` must be a callable that uses a currently visible, explicit
    project-assignment UI control and returns a fresh snapshot after the action.
    """
    problem = _mapping_problem(expected,provider)
    if problem:
        return {'status': 'blocked', 'code': 'PROJECT_MAPPING_INVALID', 'reason': problem,
                'expectedMapping': 'invalid', 'actualOwnership': 'unknown'}
    if not isinstance(evidence, dict):
        return {'status': 'verification_failed', 'code': 'PROJECT_STATE_UNKNOWN',
                'reason': 'Application ownership evidence is unavailable',
                'expectedMapping': 'bridge-registry', 'actualOwnership': 'unknown'}
    if evidence.get('ambiguous') is True:
        return {'status': 'verification_failed', 'code': 'PROJECT_STATE_AMBIGUOUS',
                'reason': 'Application reports ambiguous project navigation evidence',
                'expectedMapping': 'bridge-registry', 'actualOwnership': 'unknown'}
    capabilities = evidence.get('capabilities') or {}
    if evidence.get('conversationId') != expected['conversationId']:
        if evidence.get('conversationId') is None and not capabilities.get('conversationIdFromUrl') and not capabilities.get('dataConversationIdAttr'):
            return {'status': 'unsupported', 'code': 'UI_IDENTITY_UNSUPPORTED',
                    'reason': 'Current application UI exposes no supported conversation identity capability',
                    'expectedMapping': 'bridge-registry', 'actualOwnership': 'unknown'}
        return {'status': 'blocked', 'code': 'CONVERSATION_MISMATCH',
                'reason': 'Current application conversation does not match the registered target',
                'expectedMapping': 'bridge-registry', 'actualOwnership': evidence.get('projectId') or 'unknown'}

    project_id = expected.get('projectId')
    if project_id is None:
        if evidence.get('projectId') is None and evidence.get('workspacePath') is None:
            return {'status': 'success', 'code': 'ROUTE_VERIFIED',
                    'expectedMapping': 'ordinary-conversation', 'actualOwnership': 'ordinary-conversation',
                    'evidence': 'application conversation identity'}
        return {'status': 'blocked', 'code': 'ORDINARY_CHAT_PROJECT_DRIFT',
                'reason': 'Ordinary conversation is unexpectedly attached to a project',
                'expectedMapping': 'ordinary-conversation', 'actualOwnership': evidence.get('projectId') or 'unknown'}

    observed_workspace = evidence.get('workspacePath')
    if observed_workspace is not None and canonical_path(observed_workspace) != canonical_path(expected['workspacePath']):
        return {'status': 'blocked', 'code': 'WORKSPACE_MISMATCH',
                'reason': 'Application workspace evidence conflicts with the registered mapping',
                'expectedMapping': 'bridge-registry', 'actualOwnership': evidence.get('projectId') or 'unknown'}
    if evidence.get('projectId') == project_id:
        if canonical_path(observed_workspace) is None:
            return {'status': 'verification_failed', 'code': 'WORKSPACE_EVIDENCE_MISSING',
                    'reason': 'Application-side workspace identity is unavailable for the registered project',
                    'expectedMapping': 'bridge-registry', 'actualOwnership': project_id}
        return {'status': 'success', 'code': 'ROUTE_VERIFIED',
                'expectedMapping': 'bridge-registry', 'actualOwnership': project_id,
                'evidence': evidence.get('ownershipSource', 'application project identifier')}

    # A title or a Recent-list location is never ownership proof. Only a host
    # supplied repair callback can operate a currently exposed supported UI action.
    if evidence.get('listKind') == 'recent' and evidence.get('projectId') is None:
        if repair is None:
            return {'status': 'unsupported', 'code': 'PROJECT_REPAIR_UNSUPPORTED',
                    'reason': 'Conversation is in Recent and no authorized supported move action is available',
                    'expectedMapping': 'bridge-registry', 'actualOwnership': 'recent-unassigned'}
        try:
            repaired = repair(expected, evidence)
        except ToolError as error:
            return {'status': 'blocked', 'code': error.code, 'reason': str(error),
                    'expectedMapping': 'bridge-registry', 'actualOwnership': 'recent-unassigned'}
        if not isinstance(repaired, dict) or repaired.get('projectId') != project_id or repaired.get('conversationId') != expected['conversationId']:
            return {'status': 'verification_failed', 'code': 'PROJECT_REPAIR_UNVERIFIED',
                    'reason': 'Move action completed without verified application-side project ownership',
                    'expectedMapping': 'bridge-registry', 'actualOwnership': (repaired or {}).get('projectId', 'unknown')}
        if canonical_path(repaired.get('workspacePath')) is None or canonical_path(repaired['workspacePath']) != canonical_path(expected['workspacePath']):
            return {'status': 'verification_failed', 'code': 'PROJECT_REPAIR_WORKSPACE_MISMATCH',
                    'reason': 'Post-repair workspace does not match the registered project',
                    'expectedMapping': 'bridge-registry', 'actualOwnership': repaired.get('projectId')}
        return {'status': 'success', 'code': 'ROUTE_REPAIRED_AND_VERIFIED',
                'expectedMapping': 'bridge-registry', 'actualOwnership': project_id,
                'evidence': repaired.get('ownershipSource', 'fresh application read after move')}
    if evidence.get('projectId') is None and not capabilities.get('dataProjectIdAttr'):
        return {'status': 'unsupported', 'code': 'UI_PROJECT_IDENTITY_UNSUPPORTED',
                'reason': 'Current application UI exposes no supported project identity capability',
                'expectedMapping': 'bridge-registry', 'actualOwnership': 'unknown'}
    return {'status': 'blocked', 'code': 'PROJECT_OWNERSHIP_MISMATCH',
            'reason': 'Application-side project identifier does not match the registered target',
            'expectedMapping': 'bridge-registry', 'actualOwnership': evidence.get('projectId') or 'unknown'}


def _codex_metadata_matches(expected, metadata):
    if not isinstance(metadata, dict) or metadata.get('source') != 'codex-app-state':
        return False
    if metadata.get('conversationId') != expected.get('conversationId') or metadata.get('projectId') != expected.get('projectId'):
        return False
    if canonical_path(metadata.get('workspacePath')) != canonical_path(expected.get('workspacePath')):
        return False
    return metadata.get('observed') is True


def classify_execution_target(evidence):
    """Diagnostic classification only; UI text is explicitly untrusted observation."""
    if not isinstance(evidence,dict) or evidence.get('ambiguous') is True:
        return {'classification':'unknown','evidence':'unavailable-or-ambiguous','trusted':False}
    label=evidence.get('badgeText')
    if evidence.get('modeAttribute')=='work-cloud' or (isinstance(label,str) and label.strip().casefold() in ('work · 云端环境','work · cloud environment')):
        return {'classification':'cloud_work','evidence':'ui-observation','trusted':False}
    if evidence.get('surface')=='codex-desktop' and evidence.get('modeAttribute')=='codex-local':
        return {'classification':'local_codex','evidence':'ui-observation-awaiting-metadata-and-path-check','trusted':False}
    if evidence.get('surface')=='chatgpt-web' and evidence.get('modeAttribute') in (None,'gpt') and not evidence.get('workspacePath'):
        return {'classification':'ordinary_gpt','evidence':'ui-observation','trusted':False}
    return {'classification':'unknown','evidence':'insufficient-or-conflicting-ui-state','trusted':False}


def guard_local_codex_execution(expected, evidence, metadata, reread=None, metadata_reread=None):
    """Require the local app, exact project/thread/path, and immediate fresh recheck."""
    problem = _mapping_problem(expected, 'codex')
    if problem:
        return {'status': 'blocked', 'classification': 'unknown', 'code': 'EXECUTION_MAPPING_INVALID', 'reason': problem}

    def check(snapshot, state_metadata):
        if not isinstance(snapshot, dict) or snapshot.get('ambiguous') is True:
            return 'Execution environment snapshot unavailable', 'unknown'
        label = snapshot.get('badgeText')
        mode = snapshot.get('modeAttribute')
        if mode == 'work-cloud' or (isinstance(label, str) and label.strip().casefold() in ('work · 云端环境', 'work · cloud environment')):
            return 'Cloud Work execution is selected; local task was not sent', 'cloud_work'
        local_badge=isinstance(label,str) and label.strip().casefold() in ('codex · 本地工作区','codex · local workspace')
        if snapshot.get('surface') != 'codex-desktop' or mode not in (None,'codex-local') or (label and not local_badge):
            return 'Local Codex execution mode is not positively identified', 'unknown'
        if snapshot.get('composerState')!='ready':
            return 'Visible Codex composer is not uniquely focused and ready', 'unknown'
        if snapshot.get('conversationId') != expected.get('conversationId'):
            return 'Visible Codex conversation does not match the registered thread', 'unknown'
        if snapshot.get('projectId') != expected.get('projectId'):
            return 'Visible Codex project does not match the registered project', 'unknown'
        if canonical_path(snapshot.get('workspacePath')) != canonical_path(expected.get('workspacePath')):
            return 'Visible workspace path does not match the registered project root', 'unknown'
        if not _codex_metadata_matches(expected, state_metadata):
            return 'Codex application state does not corroborate project/thread/workspace identity', 'unknown'
        return None, 'local_codex'

    reason, classification = check(evidence, metadata)
    if reason:
        return {'status': 'blocked', 'classification': classification,
                'code': 'CLOUD_WORK_BLOCKED' if classification == 'cloud_work' else 'EXECUTION_ENVIRONMENT_UNKNOWN',
                'reason': reason, 'evidence': 'observed UI and app metadata; not model self-report'}
    if reread is None:
        return {'status': 'blocked', 'classification': 'unknown', 'code': 'EXECUTION_RECHECK_REQUIRED',
                'reason': 'A fresh execution-state check immediately before send is required'}
    fresh_metadata=None
    try:
        fresh = reread()
        fresh_metadata = metadata_reread() if metadata_reread is not None else metadata
    except Exception:
        fresh = None
    fresh_reason, fresh_classification = check(fresh, fresh_metadata)
    if fresh_reason:
        return {'status': 'blocked', 'classification': fresh_classification,
                'code': 'EXECUTION_STATE_CHANGED' if isinstance(fresh, dict) else 'EXECUTION_RECHECK_FAILED',
                'reason': fresh_reason}
    return {'status': 'success', 'classification': 'local_codex', 'code': 'LOCAL_EXECUTION_VERIFIED',
            'evidence': ['Codex desktop target', 'local execution mode attribute',
                         'conversation/project/workspace match', 'corroborating Codex app state',
                         'fresh pre-send UI recheck']}


ROUTE_SNAPSHOT_JS = r"""
(() => {
 const path=location.pathname;
 const idMatch=path.match(/\/(?:c|thread)\/([A-Za-z0-9_-]{8,})/);
 const active=[...document.querySelectorAll('[aria-current="page"][data-project-id], [data-current-project-id]')];
 const projects=[...new Set(active.map(e=>e.dataset.projectId||e.dataset.currentProjectId).filter(Boolean))];
 const workspace=[...document.querySelectorAll('[data-workspace-path]')].filter(e=>e.offsetParent!==null);
 const sections=[...document.querySelectorAll('[aria-current="page"][data-nav-section]')].map(e=>e.dataset.navSection);
 const selected=workspace.length===1?workspace[0].dataset.workspacePath:null;
 const row=idMatch&&document.querySelector(`[data-conversation-id="${CSS.escape(idMatch[1])}"]`);
 const move=row&&row.querySelector('[data-action="move-to-project"]');
 const capabilities={conversationIdFromUrl:!!idMatch,dataConversationIdAttr:document.querySelectorAll('[data-conversation-id]').length>0,dataProjectIdAttr:document.querySelectorAll('[data-project-id],[data-current-project-id]').length>0,dataWorkspacePathAttr:document.querySelectorAll('[data-workspace-path]').length>0,moveActionAttr:document.querySelectorAll('[data-action="move-to-project"]').length>0};
 return JSON.stringify({conversationId:idMatch?idMatch[1]:null,
   projectId:projects.length===1?projects[0]:null,
   ownershipSource:projects.length===1?'active-navigation-data-attribute':null,
   listKind:sections.length===1&&sections[0]==='recent'?'recent':null,
   workspacePath:selected,
   moveAction:move?{supported:true,conversationId:idMatch[1]}:null,
   capabilities:capabilities,
   ambiguous:projects.length>1||workspace.length>1||sections.length>1});
})()
"""

EXECUTION_SNAPSHOT_JS = r"""
(() => {
 const root=document.documentElement;
 const mode=root.dataset.executionMode||null;
 const threadMatch=location.pathname.match(/\/(?:c|thread)\/([A-Za-z0-9_-]{8,})/);
 const projectEls=[...document.querySelectorAll('[data-current-project-id]')];
 const projects=[...new Set(projectEls.map(e=>e.dataset.currentProjectId).filter(Boolean))];
 const paths=[...document.querySelectorAll('[data-workspace-path]')].filter(e=>e.offsetParent!==null).map(e=>e.dataset.workspacePath);
 const badges=[...document.querySelectorAll('[data-execution-badge]')].filter(e=>e.offsetParent!==null).map(e=>e.textContent.trim());
 const composers=[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].filter(e=>{const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;});
 return JSON.stringify({surface:location.protocol==='app:'?'codex-desktop':(location.hostname==='chatgpt.com'?'chatgpt-web':'unknown'),
   modeAttribute:mode, badgeText:badges.length===1?badges[0]:null,
   conversationId:threadMatch?threadMatch[1]:null,
   projectId:projects.length===1?projects[0]:null,
   workspacePath:paths.length===1?paths[0]:null,
   composerState:composers.length===1&&document.activeElement===composers[0]?'ready':(composers.length===1?'unfocused':'missing'),
   ambiguous:projects.length>1||paths.length>1});
})()
"""


def read_codex_app_binding(expected, state_path=None):
    """Read only Codex's bounded app metadata and return corroborating identity."""
    if state_path is None:
        state_path = Path.home() / '.codex' / '.codex-global-state.json'
    try:
        path = Path(state_path)
        if path.is_symlink() or not path.is_file() or path.stat().st_size > STATE_FILE_MAX_BYTES:
            return None
        raw = json.loads(path.read_text(encoding='utf-8'))
        if not isinstance(raw,dict): return None
        projects = raw.get('local-projects', {})
        assignments = raw.get('thread-project-assignments', {})
        hints = raw.get('thread-workspace-root-hints', {})
        if not all(isinstance(v,dict) for v in (projects,assignments,hints)): return None
        if len(projects)>1000 or len(assignments)>10000 or len(hints)>10000: return None
        thread = assignments.get(expected['conversationId'], {})
        if not isinstance(thread,dict): return None
        project_id = thread.get('projectId')
        matches=[p for p in projects.values() if isinstance(p,dict) and p.get('id')==project_id]
        if len(matches)!=1: return None
        project=matches[0]
        roots=project.get('rootPaths')
        if not isinstance(roots,list) or not roots or len(roots)>MAX_PATH_ROOTS or any(not isinstance(root,str) for root in roots): return None
        workspace = hints.get(expected['conversationId'])
        if workspace is None and len(roots)==1:
            workspace = roots[0]
        if not isinstance(workspace,str) or not any(canonical_path(workspace)==canonical_path(root) for root in roots): return None
        result = {'source': 'codex-app-state', 'observed': bool(project and workspace),
                  'conversationId': expected['conversationId'], 'projectId': project_id,
                  'workspacePath': workspace}
        return result
    except (OSError, ValueError, TypeError, KeyError, AttributeError):
        return None
