"""Verified Unicode clipboard paste for approved visible CDP controls.

The native adapter supports a text-only clipboard state. Rich clipboard payloads
are rejected before modification because this tool cannot faithfully restore them.
"""
import ctypes
import json
import sys

from desktop_common import ToolError, MAX_TEXT_CHARS, CLIPBOARD_MAX_BYTES, CLIPBOARD_MAX_FORMATS, KEYCODE_A, KEYCODE_V


class WindowsTextClipboard:
    CF_UNICODETEXT = 13
    GMEM_MOVEABLE = 0x0002

    def __init__(self):
        if sys.platform != 'win32':
            raise ToolError('CLIPBOARD_UNSUPPORTED', 'Verified clipboard paste requires Windows', 6, status='unsupported')
        self.user32 = ctypes.windll.user32
        self.kernel32 = ctypes.windll.kernel32
        self.user32.OpenClipboard.argtypes=[ctypes.c_void_p]; self.user32.OpenClipboard.restype=ctypes.c_int
        self.user32.CloseClipboard.argtypes=[]; self.user32.CloseClipboard.restype=ctypes.c_int
        self.user32.EnumClipboardFormats.argtypes=[ctypes.c_uint]; self.user32.EnumClipboardFormats.restype=ctypes.c_uint
        self.user32.GetClipboardData.argtypes=[ctypes.c_uint]; self.user32.GetClipboardData.restype=ctypes.c_void_p
        self.user32.EmptyClipboard.argtypes=[]; self.user32.EmptyClipboard.restype=ctypes.c_int
        self.user32.SetClipboardData.argtypes=[ctypes.c_uint,ctypes.c_void_p]; self.user32.SetClipboardData.restype=ctypes.c_void_p
        self.kernel32.GlobalLock.argtypes=[ctypes.c_void_p]; self.kernel32.GlobalLock.restype=ctypes.c_void_p
        self.kernel32.GlobalUnlock.argtypes=[ctypes.c_void_p]; self.kernel32.GlobalUnlock.restype=ctypes.c_int
        self.kernel32.GlobalSize.argtypes=[ctypes.c_void_p]; self.kernel32.GlobalSize.restype=ctypes.c_size_t
        self.kernel32.GlobalAlloc.argtypes=[ctypes.c_uint,ctypes.c_size_t]; self.kernel32.GlobalAlloc.restype=ctypes.c_void_p
        self.kernel32.GlobalFree.argtypes=[ctypes.c_void_p]; self.kernel32.GlobalFree.restype=ctypes.c_void_p

    def _open(self):
        if not self.user32.OpenClipboard(None):
            raise ToolError('CLIPBOARD_BUSY', 'Clipboard is unavailable or in use')

    def snapshot(self):
        self._open()
        try:
            formats=[]; current=0
            while True:
                current=self.user32.EnumClipboardFormats(current)
                if not current: break
                formats.append(current)
                if len(formats)>CLIPBOARD_MAX_FORMATS: raise ToolError('CLIPBOARD_UNSUPPORTED','Clipboard format count exceeded limit',6,status='unsupported')
            if any(fmt != self.CF_UNICODETEXT for fmt in formats):
                raise ToolError('CLIPBOARD_UNSUPPORTED','Clipboard contains rich/non-text data that cannot be faithfully restored',6,status='unsupported')
            if not formats: return None
            handle=self.user32.GetClipboardData(self.CF_UNICODETEXT)
            pointer=self.kernel32.GlobalLock(handle)
            if not pointer: raise ToolError('CLIPBOARD_READ_FAILED','Could not preserve existing clipboard text')
            try:
                size=self.kernel32.GlobalSize(handle)
                if not size or size>CLIPBOARD_MAX_BYTES: raise ToolError('CLIPBOARD_UNSUPPORTED','Clipboard text exceeds preservation limit',6,status='unsupported')
                value=ctypes.wstring_at(pointer, min(size//ctypes.sizeof(ctypes.c_wchar),MAX_TEXT_CHARS))
                return value.split('\x00',1)[0]
            finally:
                self.kernel32.GlobalUnlock(handle)
        finally:
            self.user32.CloseClipboard()

    def write(self, value):
        if value is not None and (not isinstance(value,str) or len(value)>MAX_TEXT_CHARS or '\x00' in value):
            raise ToolError('INPUT','Clipboard text is invalid or too long',2)
        data=(value or '').encode('utf-16-le')+b'\x00\x00'
        handle=self.kernel32.GlobalAlloc(self.GMEM_MOVEABLE,len(data))
        if not handle: raise ToolError('CLIPBOARD_WRITE_FAILED','Could not allocate clipboard text')
        pointer=self.kernel32.GlobalLock(handle)
        if not pointer:
            self.kernel32.GlobalFree(handle)
            raise ToolError('CLIPBOARD_WRITE_FAILED','Could not lock clipboard text')
        try: ctypes.memmove(pointer,data,len(data))
        finally: self.kernel32.GlobalUnlock(handle)
        try: self._open()
        except Exception:
            self.kernel32.GlobalFree(handle)
            raise
        try:
            if not self.user32.EmptyClipboard():
                self.kernel32.GlobalFree(handle)
                raise ToolError('CLIPBOARD_WRITE_FAILED','Could not replace clipboard text')
            if not self.user32.SetClipboardData(self.CF_UNICODETEXT,handle):
                self.kernel32.GlobalFree(handle)
                raise ToolError('CLIPBOARD_WRITE_FAILED','Could not publish clipboard text')
        finally:
            self.user32.CloseClipboard()

    def restore(self, value):
        self.write(value)


def _target_script(target, action):
    encoded=json.dumps(target,separators=(',',':'),ensure_ascii=False)
    return r"""/* ACB_%s */
(() => {
 const target=%s;
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect();return e.offsetParent!==null&&r.width>0&&r.height>0;};
 let e=null;
 if(target.kind==='gpt-composer'){const all=[...document.querySelectorAll('#prompt-textarea, textarea, [contenteditable="true"]')].filter(visible);if(all.length===1)e=all[0];}
 else if(target.kind==='codex-composer'){const all=[...document.querySelectorAll('.ProseMirror[contenteditable="true"]')].filter(visible);if(all.length===1)e=all[0];}
 if(!e)return JSON.stringify({found:false});
 const editable=e.matches('input,textarea')||e.isContentEditable;
 const val=e.matches('input,textarea')?e.value:e.textContent;
 %s
 return JSON.stringify({found:true,editable,value:val,focused:document.activeElement===e});
})()
""" % (action, encoded, 'e.focus();' if action=='FOCUS' else '')


def _read(connection,target):
    try: raw=connection.evaluate(_target_script(target,'READ'))
    except ToolError: raise
    except Exception: raise ToolError('PASTE_READ_FAILED','Could not read the target control after paste')
    try: state=json.loads(raw) if isinstance(raw,str) else raw
    except (ValueError,TypeError): state=None
    if not isinstance(state,dict): raise ToolError('PASTE_READ_FAILED','Target control state is not verifiable')
    return state


def _select_all(connection):
    events=[
      {'type':'keyDown','key':'Control','code':'ControlLeft','modifiers':2},
      {'type':'keyDown','key':'a','code':'KeyA','modifiers':2,'windowsVirtualKeyCode':KEYCODE_A,'nativeVirtualKeyCode':KEYCODE_A},
      {'type':'keyUp','key':'a','code':'KeyA','modifiers':2,'windowsVirtualKeyCode':KEYCODE_A,'nativeVirtualKeyCode':KEYCODE_A},
      {'type':'keyUp','key':'Control','code':'ControlLeft','modifiers':0},
    ]
    for event in events: connection.call('Input.dispatchKeyEvent',event)


def _paste_keys(connection):
    events=[
      {'type':'keyDown','key':'Control','code':'ControlLeft','modifiers':2},
      {'type':'keyDown','key':'v','code':'KeyV','modifiers':2,'windowsVirtualKeyCode':KEYCODE_V,'nativeVirtualKeyCode':KEYCODE_V},
      {'type':'keyUp','key':'v','code':'KeyV','modifiers':2,'windowsVirtualKeyCode':KEYCODE_V,'nativeVirtualKeyCode':KEYCODE_V},
      {'type':'keyUp','key':'Control','code':'ControlLeft','modifiers':0},
    ]
    for event in events: connection.call('Input.dispatchKeyEvent',event)


def paste_text(connection, target, text, clipboard=None):
    if not isinstance(text,str) or not text or len(text)>MAX_TEXT_CHARS or '\x00' in text:
        raise ToolError('INPUT','Text to paste is empty or exceeds the limit',2)
    clipboard=clipboard or WindowsTextClipboard()
    before=_read(connection,target)
    if not before.get('found') or before.get('editable') is not True:
        raise ToolError('PASTE_TARGET_INVALID','Target control is missing or not editable')
    try: original=clipboard.snapshot()
    except ToolError: raise
    except Exception: raise ToolError('CLIPBOARD_READ_FAILED','Could not preserve clipboard state')
    restore_error=None
    try:
        clipboard.write(text)
        try: focused=connection.evaluate(_target_script(target,'FOCUS'))
        except ToolError: raise
        except Exception: raise ToolError('PASTE_FOCUS_FAILED','Could not focus the validated target control')
        try: focus_state=json.loads(focused) if isinstance(focused,str) else focused
        except (ValueError,TypeError): focus_state=None
        if not isinstance(focus_state,dict) or not focus_state.get('found') or focus_state.get('focused') is not True:
            raise ToolError('PASTE_FOCUS_FAILED','Target control did not retain focus')
        _select_all(connection)
        selected=_read(connection,target)
        if selected.get('found') is not True or selected.get('focused') is not True or selected.get('value')!=before.get('value'):
            raise ToolError('PASTE_FOCUS_FAILED','Target focus or content changed before replacement paste')
        _paste_keys(connection)
        after=_read(connection,target)
        if after.get('found') is not True or after.get('focused') is not True or after.get('value') != text:
            raise ToolError('PASTE_MISMATCH','Clipboard paste did not produce the exact requested text',4,status='verification_failed')
        result={'status':'success','code':'PASTE_VERIFIED','valueVerified':True}
    finally:
        try: clipboard.restore(original)
        except Exception: restore_error=True
    if restore_error:
        # 安全清理：仅当剪贴板内容仍是本次写入的 text 时才清空（确认所有权），不误清用户新复制内容
        try:
            current = clipboard.snapshot()
            if current == text:
                clipboard.write('')
        except Exception:
            pass
        raise ToolError('CLIPBOARD_RESTORE_FAILED','Paste completed but the original clipboard could not be restored',6,status='verification_failed')
    return result
