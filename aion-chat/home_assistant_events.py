"""
Home Assistant state-change listener for local sensor experiments.

The listener is opt-in: if data/home_assistant_events.json is missing or
disabled, it does not start. Runtime failures are logged and retried without
affecting the main app.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from typing import Any

from config import BASE_DIR, load_worldbook

log = logging.getLogger("home_assistant_events")

HA_CONFIG_PATH = BASE_DIR / "data" / "home_assistant_mcp.json"
EVENT_CONFIG_PATH = BASE_DIR / "data" / "home_assistant_events.json"
EVENT_LOG_PATH = BASE_DIR / "data" / "home_assistant_events.jsonl"


class HomeAssistantEventListener:
    def __init__(self) -> None:
        self._task: asyncio.Task | None = None
        self._stop_event: asyncio.Event | None = None
        self._last_emit: dict[str, float] = {}
        self._active_repeats: dict[str, dict[str, Any]] = {}
        self._active_repeat_after: dict[str, float] = {}
        self._last_scene: str | None = None
        self._last_activity_signature: tuple[str, ...] | None = None
        self._last_activity_signature_loaded = False

    def start(self) -> None:
        if self._task and not self._task.done():
            return
        cfg = self._load_event_config()
        if not cfg.get("enabled"):
            log.info("Home Assistant event listener disabled")
            return
        ha = self._load_ha_config()
        if not ha.get("ha_url") or not ha.get("ha_token"):
            log.info("Home Assistant event listener skipped: HA config is incomplete")
            return
        entities = self._configured_entities(cfg)
        if not entities:
            log.info("Home Assistant event listener skipped: no entities configured")
            return
        self._stop_event = asyncio.Event()
        self._task = asyncio.create_task(self._run(), name="home-assistant-events")
        log.info("Home Assistant event listener started for %d entities", len(entities))

    async def stop(self) -> None:
        if self._stop_event:
            self._stop_event.set()
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._stop_event = None
        self._active_repeats.clear()
        self._active_repeat_after.clear()

    async def _run(self) -> None:
        while not self._should_stop():
            try:
                cfg = self._load_event_config()
                ha = self._load_ha_config()
                await self._listen_once(cfg, ha)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                log.warning("Home Assistant event listener error: %s", exc)
                await self._sleep(10)

    async def _listen_once(self, cfg: dict[str, Any], ha: dict[str, Any]) -> None:
        entities = self._configured_entities(cfg)
        if not entities:
            await self._sleep(30)
            return

        url = self._websocket_url(str(ha.get("ha_url", "")))
        token = str(ha.get("ha_token", ""))

        try:
            import websockets
        except Exception as exc:
            log.warning("Home Assistant event listener requires websockets: %s", exc)
            await self._sleep(60)
            return

        async with websockets.connect(url, ping_interval=20, ping_timeout=20) as ws:
            auth_required = json.loads(await ws.recv())
            if auth_required.get("type") != "auth_required":
                raise RuntimeError(f"Unexpected HA websocket greeting: {auth_required!r}")
            await ws.send(json.dumps({"type": "auth", "access_token": token}))
            auth_result = json.loads(await ws.recv())
            if auth_result.get("type") != "auth_ok":
                raise RuntimeError(f"Home Assistant websocket auth failed: {auth_result!r}")

            await ws.send(json.dumps({"id": 1, "type": "subscribe_events", "event_type": "state_changed"}))
            sub_result = json.loads(await ws.recv())
            if not sub_result.get("success"):
                raise RuntimeError(f"Home Assistant subscribe failed: {sub_result!r}")

            await ws.send(json.dumps({"id": 2, "type": "get_states"}))
            states_result = await self._wait_for_result(ws, 2, cfg, entities)
            if isinstance(states_result.get("result"), list):
                await self._seed_active_repeats(states_result["result"], cfg, entities)

            log.info("Home Assistant event listener connected")
            while not self._should_stop():
                try:
                    raw = await asyncio.wait_for(ws.recv(), timeout=self._active_check_interval(cfg))
                except asyncio.TimeoutError:
                    await self._emit_due_active_repeats(cfg, entities)
                    continue
                data = json.loads(raw)
                if data.get("type") != "event":
                    continue
                await self._handle_state_event(data.get("event") or {}, cfg, entities)
                await self._emit_due_active_repeats(cfg, entities)

    async def _wait_for_result(
        self,
        ws: Any,
        expected_id: int,
        cfg: dict[str, Any],
        entities: dict[str, dict[str, Any]],
    ) -> dict[str, Any]:
        deadline = time.time() + 10
        while not self._should_stop():
            timeout = max(0.1, deadline - time.time())
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
            except asyncio.TimeoutError:
                return {}
            data = json.loads(raw)
            if data.get("type") == "result" and data.get("id") == expected_id:
                return data
            if data.get("type") == "event":
                await self._handle_state_event(data.get("event") or {}, cfg, entities)
            if time.time() >= deadline:
                return {}
        return {}

    async def _handle_state_event(
        self,
        event: dict[str, Any],
        cfg: dict[str, Any],
        entities: dict[str, dict[str, Any]],
    ) -> None:
        event_data = event.get("data") or {}
        entity_id = event_data.get("entity_id", "")
        rule = entities.get(entity_id)
        if not rule:
            return

        old_state = event_data.get("old_state") or {}
        new_state = event_data.get("new_state") or {}
        old_value = str(old_state.get("state", ""))
        new_value = str(new_state.get("state", ""))
        self._track_active_repeat(entity_id, rule, new_state)
        if not self._matches_rule(rule, old_value, new_value):
            return
        if not self._cooldown_ok(entity_id, cfg, rule):
            return

        payload = self._build_payload(entity_id, rule, new_state, old_value, event.get("time_fired") or "")
        await self._emit_sensor_event(payload, cfg)

    def _matches_rule(self, rule: dict[str, Any], old_value: str, new_value: str) -> bool:
        if new_value in {"", "unknown", "unavailable"}:
            return False
        if old_value == new_value and not rule.get("trigger_on_same_state"):
            return False
        numeric_match = self._matches_numeric_rule(rule, new_value)
        if numeric_match is not None:
            return numeric_match
        if rule.get("trigger_any_change"):
            return True
        trigger_states = rule.get("trigger_states")
        if not isinstance(trigger_states, list) or not trigger_states:
            trigger_states = ["on"]
        normalized = {str(item).strip().lower() for item in trigger_states if str(item).strip()}
        return new_value.lower() in normalized

    def _matches_numeric_rule(self, rule: dict[str, Any], new_value: str) -> bool | None:
        has_lower_bound = "numeric_above" in rule or "numeric_min" in rule
        has_upper_bound = "numeric_below" in rule or "numeric_max" in rule
        if not has_lower_bound and not has_upper_bound:
            return None
        try:
            value = float(new_value)
        except (TypeError, ValueError):
            return False
        if has_lower_bound:
            try:
                lower = float(rule.get("numeric_above", rule.get("numeric_min")))
            except (TypeError, ValueError):
                return False
            if value <= lower:
                return False
        if has_upper_bound:
            try:
                upper = float(rule.get("numeric_below", rule.get("numeric_max")))
            except (TypeError, ValueError):
                return False
            if value >= upper:
                return False
        return True

    def _cooldown_ok(self, entity_id: str, cfg: dict[str, Any], rule: dict[str, Any]) -> bool:
        cooldown = self._cooldown_seconds(cfg, rule)
        now = time.time()
        last = self._last_emit.get(entity_id, 0)
        if now - last < cooldown:
            return False
        self._last_emit[entity_id] = now
        return True

    def _cooldown_seconds(self, cfg: dict[str, Any], rule: dict[str, Any]) -> float:
        cooldown = rule.get("cooldown_seconds", cfg.get("cooldown_seconds", 300))
        try:
            return max(0, float(cooldown))
        except (TypeError, ValueError):
            return 300

    def _active_check_interval(self, cfg: dict[str, Any]) -> float:
        value = cfg.get("active_check_interval_seconds", 10)
        try:
            return max(1, min(60, float(value)))
        except (TypeError, ValueError):
            return 10

    async def _seed_active_repeats(
        self,
        states: list[dict[str, Any]],
        cfg: dict[str, Any],
        entities: dict[str, dict[str, Any]],
    ) -> None:
        now = time.time()
        for state in states:
            if not isinstance(state, dict):
                continue
            entity_id = str(state.get("entity_id") or "")
            rule = entities.get(entity_id)
            if not rule:
                continue
            if self._track_active_repeat(entity_id, rule, state, initial=True):
                if rule.get("emit_initial_active", cfg.get("emit_initial_active")):
                    if self._cooldown_ok(entity_id, cfg, rule):
                        payload = dict(self._active_repeats[entity_id])
                        payload["initial"] = True
                        payload["created_at"] = time.time()
                        await self._emit_sensor_event(payload, cfg)
                else:
                    self._active_repeat_after[entity_id] = now + self._cooldown_seconds(cfg, rule)

    def _track_active_repeat(
        self,
        entity_id: str,
        rule: dict[str, Any],
        state: dict[str, Any],
        initial: bool = False,
    ) -> bool:
        repeat_states = self._repeat_states(rule)
        if not repeat_states:
            self._active_repeats.pop(entity_id, None)
            self._active_repeat_after.pop(entity_id, None)
            return False
        state_value = str(state.get("state", "")).lower()
        if state_value in repeat_states:
            self._active_repeats[entity_id] = self._build_payload(entity_id, rule, state, "", "")
            if not initial:
                self._active_repeat_after.pop(entity_id, None)
            return True
        self._active_repeats.pop(entity_id, None)
        self._active_repeat_after.pop(entity_id, None)
        return False

    def _repeat_states(self, rule: dict[str, Any]) -> set[str]:
        repeat_value = rule.get("repeat_while_state")
        if repeat_value is True or (repeat_value is None and rule.get("repeat_while_active")):
            repeat_value = rule.get("trigger_states") or ["on"]
        if isinstance(repeat_value, str):
            values = [repeat_value]
        elif isinstance(repeat_value, list):
            values = repeat_value
        else:
            return set()
        return {
            str(item).strip().lower()
            for item in values
            if str(item).strip() and str(item).strip().lower() not in {"unknown", "unavailable"}
        }

    async def _emit_due_active_repeats(
        self,
        cfg: dict[str, Any],
        entities: dict[str, dict[str, Any]],
    ) -> None:
        now = time.time()
        for entity_id, payload in list(self._active_repeats.items()):
            rule = entities.get(entity_id)
            if not rule:
                self._active_repeats.pop(entity_id, None)
                self._active_repeat_after.pop(entity_id, None)
                continue
            if now < self._active_repeat_after.get(entity_id, 0):
                continue
            if not self._cooldown_ok(entity_id, cfg, rule):
                continue
            self._active_repeat_after.pop(entity_id, None)
            repeat_payload = dict(payload)
            repeat_payload["repeat"] = True
            repeat_payload["created_at"] = time.time()
            await self._emit_sensor_event(repeat_payload, cfg)

    def _build_payload(
        self,
        entity_id: str,
        rule: dict[str, Any],
        state: dict[str, Any],
        old_value: str,
        time_fired: str,
    ) -> dict[str, Any]:
        attrs = state.get("attributes") or {}
        payload = {
            "entity_id": entity_id,
            "label": rule.get("label") or attrs.get("friendly_name") or entity_id,
            "area": rule.get("area") or "",
            "state": str(state.get("state", "")),
            "old_state": old_value,
            "friendly_name": attrs.get("friendly_name") or "",
            "time_fired": time_fired,
            "created_at": time.time(),
        }
        self._add_numeric_payload_fields(payload, rule)
        return payload

    def _add_numeric_payload_fields(self, payload: dict[str, Any], rule: dict[str, Any]) -> None:
        if not any(key in rule for key in ("numeric_below", "numeric_max", "numeric_above", "numeric_min")):
            return
        try:
            payload["numeric_value"] = float(payload.get("state", ""))
        except (TypeError, ValueError):
            return
        if "numeric_below" in rule or "numeric_max" in rule:
            payload["numeric_below"] = rule.get("numeric_below", rule.get("numeric_max"))
        if "numeric_above" in rule or "numeric_min" in rule:
            payload["numeric_above"] = rule.get("numeric_above", rule.get("numeric_min"))

    async def _emit_sensor_event(self, payload: dict[str, Any], cfg: dict[str, Any]) -> None:
        await self._append_event_log(payload)

    def _is_duplicate_activity_entry(self, entry: dict[str, Any]) -> bool:
        signature = self._activity_signature(entry)
        if not self._last_activity_signature_loaded:
            self._last_activity_signature = self._latest_activity_signature_from_log()
            self._last_activity_signature_loaded = True
        return signature == self._last_activity_signature

    def _latest_activity_signature_from_log(self) -> tuple[str, ...] | None:
        try:
            for entry in reversed(read_recent_activity()):
                if entry.get("device") == "home" and entry.get("kind") == "home_sensor":
                    return self._activity_signature(entry)
        except Exception as exc:
            log.debug("Failed to inspect latest home activity log: %s", exc)
        return None

    def _activity_signature(self, entry: dict[str, Any]) -> tuple[str, ...]:
        return (
            str(entry.get("device") or "").strip(),
            str(entry.get("kind") or "").strip(),
            str(entry.get("app") or "").strip(),
            str(entry.get("title") or "").strip(),
            str(entry.get("detail") or "").strip(),
            str(entry.get("area") or "").strip(),
            str(entry.get("entity_id") or "").strip(),
            str(entry.get("sensor_label") or "").strip(),
        )

    def _build_activity_entry(self, payload: dict[str, Any]) -> dict[str, Any] | None:
        ts = float(payload.get("created_at") or time.time())
        scene = self._scene_name(payload)
        user_name = self._user_name()
        if payload.get("repeat") and scene != self._last_scene:
            return None
        if payload.get("repeat") or scene == self._last_scene:
            title = f"【{user_name}】仍然在{scene}活动"
        else:
            title = f"【{user_name}】去了{scene}"
        self._last_scene = scene
        label = str(payload.get("label") or payload.get("friendly_name") or payload.get("entity_id") or "").strip()
        detail = f"由 {label} 触发" if label else "由 Home Assistant 传感器触发"
        if "numeric_value" in payload:
            detail += f"；当前值 {payload['numeric_value']:g}"
        if payload.get("repeat"):
            detail += "；持续占用复查"
        return {
            "timestamp": ts,
            "time": time.strftime("%H:%M:%S", time.localtime(ts)),
            "date": time.strftime("%Y-%m-%d", time.localtime(ts)),
            "device": "home",
            "app": "Home Assistant",
            "title": title,
            "kind": "home_sensor",
            "area": scene,
            "entity_id": payload.get("entity_id") or "",
            "sensor_label": label,
            "detail": detail,
        }

    def _scene_name(self, payload: dict[str, Any]) -> str:
        area = str(payload.get("area") or "").strip()
        label = str(payload.get("label") or payload.get("friendly_name") or "").strip()
        return area or label or "家里"

    def _user_name(self) -> str:
        try:
            wb = load_worldbook()
            return str(wb.get("user_name") or "用户").strip() or "用户"
        except Exception:
            return "用户"

    async def _append_event_log(self, payload: dict[str, Any]) -> None:
        try:
            EVENT_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
            with EVENT_LOG_PATH.open("a", encoding="utf-8") as fh:
                fh.write(json.dumps(payload, ensure_ascii=False) + "\n")
        except Exception as exc:
            log.debug("Home sensor event log write failed: %s", exc)

    def _configured_entities(self, cfg: dict[str, Any]) -> dict[str, dict[str, Any]]:
        entities = cfg.get("entities")
        if not isinstance(entities, list):
            return {}
        result: dict[str, dict[str, Any]] = {}
        for item in entities:
            if not isinstance(item, dict):
                continue
            entity_id = str(item.get("entity_id") or "").strip()
            if entity_id:
                result[entity_id] = item
        return result

    def _load_event_config(self) -> dict[str, Any]:
        if not EVENT_CONFIG_PATH.exists():
            return {"enabled": False}
        try:
            data = json.loads(EVENT_CONFIG_PATH.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            log.warning("Failed to read Home Assistant event config: %s", exc)
            return {"enabled": False}
        return data if isinstance(data, dict) else {"enabled": False}

    def _load_ha_config(self) -> dict[str, Any]:
        if not HA_CONFIG_PATH.exists():
            return {}
        try:
            data = json.loads(HA_CONFIG_PATH.read_text(encoding="utf-8-sig"))
        except Exception as exc:
            log.warning("Failed to read Home Assistant config: %s", exc)
            return {}
        return data if isinstance(data, dict) else {}

    def _websocket_url(self, ha_url: str) -> str:
        base = ha_url.rstrip("/")
        if base.startswith("https://"):
            return "wss://" + base[len("https://") :] + "/api/websocket"
        if base.startswith("http://"):
            return "ws://" + base[len("http://") :] + "/api/websocket"
        return base + "/api/websocket"

    def _should_stop(self) -> bool:
        return bool(self._stop_event and self._stop_event.is_set())

    async def _sleep(self, seconds: float) -> None:
        if not self._stop_event:
            await asyncio.sleep(seconds)
            return
        try:
            await asyncio.wait_for(self._stop_event.wait(), timeout=seconds)
        except asyncio.TimeoutError:
            pass


ha_event_listener = HomeAssistantEventListener()
