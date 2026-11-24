"""Unit tests for the bridge's auto-start-on-launch behavior.

Runs WITHOUT LibreOffice: the uno/unohelper/com.sun.star modules are
stubbed in sys.modules before importing extension/acpbridge.py, and
APPDATA is pointed at a temp dir so the discovery records and
bridge-settings.json land in a sandbox.

Usage (any python 3.9+):
  python3 test-bridge/autostart_unit.py
"""

import json
import os
import sys
import tempfile
import types
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
EXTENSION = os.path.normpath(os.path.join(HERE, "..", "extension"))


def _stub_uno_modules():
    """Install minimal fake uno modules so acpbridge imports cleanly."""

    class _Base:
        def __init__(self, *args, **kwargs):
            pass

    class _ImplementationHelper:
        def addImplementation(self, *args, **kwargs):
            pass

    uno = types.ModuleType("uno")
    uno.getComponentContext = lambda: _FAKE_CTX
    uno.getTypeByName = lambda name: object
    unohelper = types.ModuleType("unohelper")
    unohelper.Base = _Base
    unohelper.ImplementationHelper = _ImplementationHelper

    class _FakeDesktop:
        def getCurrentComponent(self):
            return None

    class _FakeServiceManager:
        def createInstanceWithContext(self, name, ctx):
            if name == "com.sun.star.frame.Desktop":
                return _FakeDesktop()
            return object()

    class _FakeCtx:
        ServiceManager = _FakeServiceManager()

    _FAKE_CTX = _FakeCtx()

    def pkg(name):
        m = types.ModuleType(name)
        m.__path__ = []
        sys.modules[name] = m
        return m

    pkg("com")
    pkg("com.sun")
    pkg("com.sun.star")

    def leaf(name, **attrs):
        m = types.ModuleType(name)
        for k, v in attrs.items():
            setattr(m, k, v)
        sys.modules[name] = m
        parent, _, child = name.rpartition(".")
        if parent in sys.modules:
            setattr(sys.modules[parent], child, m)
        return m

    class _If:
        pass

    leaf("com.sun.star.awt", XCallback=_If)
    leaf("com.sun.star.awt.FontSlant", NONE=0, ITALIC=1)
    leaf("com.sun.star.awt.FontUnderline", SINGLE=1)
    leaf("com.sun.star.awt.FontWeight", BOLD=1)
    leaf("com.sun.star.task", XJobExecutor=_If)
    leaf("com.sun.star.text")
    leaf("com.sun.star.text.ControlCharacter", PARAGRAPH_BREAK=1)
    leaf("com.sun.star.text.TextContentAnchorType", AS_CHARACTER=1)
    leaf("com.sun.star.view", XSelectionChangeListener=_If)

    sys.modules["uno"] = uno
    sys.modules["unohelper"] = unohelper


_stub_uno_modules()
sys.path.insert(0, EXTENSION)

import acpbridge  # noqa: E402


class AutoStartTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        # Redirect the per-user dirs into the sandbox.
        self._old = {k: os.environ.get(k) for k in ("APPDATA", "XDG_CONFIG_HOME")}
        os.environ["APPDATA"] = self.tmp.name
        os.environ.pop("XDG_CONFIG_HOME", None)
        self.addCleanup(self._restore_env)
        # Reset the module-global server state between tests.
        acpbridge._STATE.update(server=None, port=None, token=None, startedAt=None)
        acpbridge._stop_server()

    def _restore_env(self):
        for k, v in self._old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def _job(self):
        return acpbridge.BridgeJob(acpbridge._context())

    def _settings(self):
        path = os.path.join(self.tmp.name, acpbridge.APP_NAME, "bridge-settings.json")
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def test_autostart_default_on(self):
        # No settings file yet -> autoStart defaults to TRUE.
        self.assertTrue(acpbridge.autostart_enabled())
        out = json.loads(self._job().trigger("autostart"))
        self.assertEqual(out["status"], "running")
        self.assertTrue(out["autoStart"])
        # A discovery record was written.
        self.assertTrue(os.path.exists(acpbridge._discovery_path()))
        acpbridge._stop_server()

    def test_autostart_respects_disabled_setting(self):
        out = json.loads(self._job().trigger("set-autostart-off"))
        self.assertFalse(out["autoStart"])
        self.assertFalse(self._settings()["autoStart"])
        # autostart event must NOT start the server now.
        out = json.loads(self._job().trigger("autostart"))
        self.assertEqual(out["status"], "autostart-disabled")
        self.assertFalse(out["autoStart"])
        self.assertIsNone(acpbridge._STATE["server"])
        # ...but a forced start still works.
        out = json.loads(self._job().trigger("start"))
        self.assertEqual(out["status"], "running")
        acpbridge._stop_server()

    def test_toggle_autostart(self):
        self.assertTrue(acpbridge.autostart_enabled())
        out = json.loads(self._job().trigger("toggle-autostart"))
        self.assertFalse(out["autoStart"])
        out = json.loads(self._job().trigger("toggle-autostart"))
        self.assertTrue(out["autoStart"])
        self.assertTrue(self._settings()["autoStart"])

    def test_set_autostart_on(self):
        self._job().trigger("set-autostart-off")
        out = json.loads(self._job().trigger("set-autostart-on"))
        self.assertTrue(out["autoStart"])
        out = json.loads(self._job().trigger("autostart"))
        self.assertEqual(out["status"], "running")
        acpbridge._stop_server()

    def test_corrupt_settings_file_falls_back_to_default(self):
        path = os.path.join(self.tmp.name, acpbridge.APP_NAME, "bridge-settings.json")
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write("{ not json")
        self.assertTrue(acpbridge.autostart_enabled())

    def test_unknown_event(self):
        out = json.loads(self._job().trigger("bogus"))
        self.assertIn("error", out)

    def test_start_is_idempotent(self):
        first = json.loads(self._job().trigger("start"))
        second = json.loads(self._job().trigger("start"))
        self.assertEqual(first["status"], "running")
        self.assertEqual(second["status"], "already-running")
        self.assertEqual(first["port"], second["port"])
        out = json.loads(self._job().trigger("stop"))
        self.assertEqual(out["status"], "stopped")
        # The discovery record is removed on stop.
        self.assertFalse(os.path.exists(acpbridge._discovery_path()))


if __name__ == "__main__":
    unittest.main(verbosity=2)
