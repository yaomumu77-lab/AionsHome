import asyncio
import json
import re
import time
from typing import Optional

import aiosqlite
from fastapi import APIRouter
from fastapi.responses import FileResponse, Response, StreamingResponse
from pydantic import BaseModel

from ai_providers import CLI_STATUS_PREFIX, stream_ai
from config import DEFAULT_MODEL, MODELS, iter_visible_models, load_worldbook
from database import get_db
from date_theater import (
    DATE_THEATER_TTS_CACHE_DIR,
    build_end_prompt,
    build_outline_prompt,
    build_prompt_usage_report,
    build_reply_prompt,
    build_sync_card_attachment,
    build_sync_message,
    delete_date_message,
    delete_date_session,
    extract_stage_commands,
    find_last_chat_target,
    insert_sync_message,
    list_date_message_tts_urls,
    list_summary_sync_targets,
    load_date_config,
    now_id,
    parse_end_payload,
    parse_outline_payload,
    resolve_sync_target,
    resolve_date_model,
    save_date_config,
    scan_date_assets,
)
from chatroom import get_chatroom_names, load_chatroom_config
from music import get_audio_url, search_songs
from tts import TTSStreamer
from ws import manager


router = APIRouter(prefix="/api/date-theater", tags=["date-theater"])

DATE_TTS_MIN_CHARS = 80
DATE_TTS_MAX_CHARS = 180
DATE_TTS_AUDIO_PREFIX = "/api/date-theater/tts/audio"


class DateConfigUpdate(BaseModel):
    partner_name: Optional[str] = None
    persona: Optional[str] = None
    persona_presets: Optional[list[dict]] = None
    active_persona_id: Optional[str] = None
    model: Optional[str] = None
    model_locked: Optional[bool] = None


class DateOutlineRequest(BaseModel):
    prompt: str
    session_id: Optional[str] = None
    partner_name: Optional[str] = None
    persona: Optional[str] = None
    active_persona_id: Optional[str] = None
    model: str = ""
    temperature: Optional[float] = None


class DateStartRequest(BaseModel):
    model: str = ""
    temperature: Optional[float] = None


class DateSendRequest(BaseModel):
    content: str
    model: str = ""
    temperature: Optional[float] = None
    tts_enabled: bool = False
    tts_voice: str = ""


class DateSyncRequest(BaseModel):
    target_type: str = ""
    target_id: str = ""


def _world_names() -> tuple[str, str]:
    wb = load_worldbook()
    return (wb.get("user_name") or "用户").strip() or "用户", (wb.get("ai_name") or "AI").strip() or "AI"


def _private_label() -> str:
    _user_name, ai_name = _world_names()
    return f"{ai_name} 私聊"


def _sync_target_names() -> tuple[str, str]:
    _user_name, ai_name, connor_name = get_chatroom_names()
    return ai_name, connor_name


def _model_rows() -> list[dict]:
    return [
        {
            "key": key,
            "provider": meta.get("provider", ""),
            "custom": meta.get("provider") == "custom_openai",
            "route_name": meta.get("route_name", ""),
        }
        for key, meta in iter_visible_models()
    ]


def _resolve_model(requested: str = "", cfg: dict | None = None) -> str:
    return resolve_date_model(
        requested=requested,
        cfg=cfg or load_date_config(),
        chatroom_cfg=load_chatroom_config(),
        model_keys=[key for key, _meta in iter_visible_models()],
    )


def _session_from_row(row) -> dict:
    data = dict(row)
    for key in ("outline_usage", "end_usage"):
        raw = data.get(key)
        if isinstance(raw, str):
            try:
                data[key] = json.loads(raw) if raw else {}
            except Exception:
                data[key] = {}
    return data


def _message_from_row(row) -> dict:
    data = dict(row)
    try:
        data["attachments"] = json.loads(data.get("attachments") or "[]")
    except Exception:
        data["attachments"] = []
    return data


async def _collect_ai_text(messages: list[dict], model_key: str, *, temperature: float | None = None) -> str:
    text, _usage = await _collect_ai_response(messages, model_key, temperature=temperature)
    return text


async def _collect_ai_response(messages: list[dict], model_key: str, *, temperature: float | None = None) -> tuple[str, dict]:
    usage_meta: dict = {}
    chunks: list[str] = []
    async for chunk in stream_ai(messages, model_key, usage_meta, temperature=temperature):
        if chunk.startswith(CLI_STATUS_PREFIX):
            continue
        chunks.append(chunk)
    return "".join(chunks).strip(), usage_meta


async def _load_session(db, session_id: str) -> dict | None:
    db.row_factory = aiosqlite.Row
    cur = await db.execute("SELECT * FROM date_sessions WHERE id=?", (session_id,))
    row = await cur.fetchone()
    return _session_from_row(row) if row else None


async def _load_messages(db, session_id: str, *, limit: int = 80) -> list[dict]:
    db.row_factory = aiosqlite.Row
    cur = await db.execute(
        "SELECT * FROM date_messages WHERE session_id=? ORDER BY created_at DESC LIMIT ?",
        (session_id, limit),
    )
    rows = await cur.fetchall()
    return [_message_from_row(row) for row in reversed(rows)]


def _valid_ids(assets: dict, key: str) -> set[str]:
    return {str(item.get("id") or "").strip() for item in assets.get(key, []) if str(item.get("id") or "").strip()}


def _validated_commands(commands: dict, assets: dict) -> dict:
    backgrounds = _valid_ids(assets, "backgrounds")
    states = _valid_ids(assets, "states")
    bg = commands.get("background")
    state = commands.get("state")
    return {
        "background": bg if bg in backgrounds else None,
        "state": state if state in states else None,
        "music": commands.get("music") or [],
        "end_ready": bool(commands.get("end_ready")),
    }


def _resolve_music_cards(keywords: list[str]) -> list[dict]:
    cards: list[dict] = []
    seen: set[int] = set()
    for keyword in keywords:
        try:
            results = search_songs(keyword, limit=1)
        except Exception:
            results = []
        if not results:
            continue
        song = dict(results[0])
        song_id = song.get("id")
        if song_id in seen:
            continue
        seen.add(song_id)
        try:
            song["audio_url"] = get_audio_url(song_id)
        except Exception:
            song["audio_url"] = None
        song["keyword"] = keyword
        cards.append(song)
    return cards


def _stage_attachment(commands: dict, music_cards: list[dict]) -> list[dict]:
    attachments: list[dict] = []
    stage = {
        "type": "date_stage",
        "background": commands.get("background"),
        "state": commands.get("state"),
        "end_ready": bool(commands.get("end_ready")),
    }
    if stage["background"] or stage["state"] or stage["end_ready"]:
        attachments.append(stage)
    if music_cards:
        attachments.append({"type": "music", "items": music_cards})
    return attachments


@router.get("/config")
async def get_config():
    user_name, ai_name = _world_names()
    cfg = load_date_config()
    cfg["model"] = _resolve_model("", cfg)
    chatroom_cfg = load_chatroom_config()
    return {
        "config": cfg,
        "world": {"user_name": user_name, "ai_name": ai_name},
        "assets": scan_date_assets(),
        "models": _model_rows(),
        "chatroom_model": chatroom_cfg.get("aion_model") or "",
    }


@router.put("/config")
async def update_config(body: DateConfigUpdate):
    cfg = save_date_config(body.dict(exclude_none=True))
    cfg["model"] = _resolve_model("", cfg)
    return {"config": cfg, "models": _model_rows(), "chatroom_model": load_chatroom_config().get("aion_model") or ""}


@router.get("/assets")
async def get_assets():
    return scan_date_assets()


@router.get("/sessions")
async def list_sessions():
    async with get_db() as db:
        db.row_factory = aiosqlite.Row
        cur = await db.execute("SELECT * FROM date_sessions ORDER BY updated_at DESC LIMIT 30")
        rows = await cur.fetchall()
        return [_session_from_row(row) for row in rows]


@router.get("/sessions/{session_id}")
async def get_session(session_id: str):
    async with get_db() as db:
        session = await _load_session(db, session_id)
        if not session:
            return Response(content=json.dumps({"error": "session not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        messages = await _load_messages(db, session_id)
    return {"session": session, "messages": messages, "assets": scan_date_assets()}


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str):
    async with get_db() as db:
        deleted = await delete_date_session(db, session_id)
        if not deleted:
            return Response(content=json.dumps({"error": "session not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        await db.commit()
    return {"ok": True}


@router.post("/sessions/outline")
async def generate_outline(body: DateOutlineRequest):
    user_prompt = (body.prompt or "").strip()
    if not user_prompt:
        return Response(content=json.dumps({"error": "prompt is empty"}, ensure_ascii=False), status_code=400, media_type="application/json")

    cfg = load_date_config()
    user_name, _ai_name = _world_names()
    assets = scan_date_assets()
    persona = (body.persona or cfg.get("persona") or "").strip()
    partner_name = (body.partner_name or cfg.get("partner_name") or "AI").strip() or "AI"
    model_key = _resolve_model(body.model, cfg)
    prompt = build_outline_prompt(
        partner_name=partner_name,
        user_name=user_name,
        persona=persona,
        user_prompt=user_prompt,
        assets=assets,
    )
    messages = [{"role": "user", "content": prompt}]

    try:
        raw, usage_meta = await _collect_ai_response(messages, model_key, temperature=body.temperature)
    except Exception:
        raw = ""
        usage_meta = {}
    outline = parse_outline_payload(raw, assets)
    usage_report = build_prompt_usage_report(
        purpose="outline",
        usage_meta=usage_meta,
        parts=[
            {"label": "用户约会提示", "content": user_prompt},
            {"label": "选定约会人设", "content": persona},
            {"label": "约会大纲规则和可用素材", "content": prompt},
        ],
    )

    now = time.time()
    session_id = (body.session_id or "").strip()
    async with get_db() as db:
        existing = await _load_session(db, session_id) if session_id else None
        if existing and existing.get("status") in {"draft", "outlined"}:
            await db.execute(
                """
                UPDATE date_sessions
                SET title=?, status='outlined', prompt=?, outline=?, opening=?, partner_name=?, persona=?, model=?,
                    ending_trigger=?, current_background=?, current_state=?, outline_usage=?, updated_at=?
                WHERE id=?
                """,
                (
                    outline["title"],
                    user_prompt,
                    outline["outline"],
                    outline["opening"],
                    partner_name,
                    persona,
                    model_key,
                    outline["ending_trigger"],
                    outline["background"],
                    outline["state"],
                    json.dumps(usage_report, ensure_ascii=False),
                    now,
                    session_id,
                ),
            )
        else:
            session_id = now_id("date")
            await db.execute(
                """
                INSERT INTO date_sessions
                (id, title, summary, status, prompt, outline, opening, partner_name, persona, model, ending_trigger,
                 outline_usage, current_background, current_state, created_at, updated_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                """,
                (
                    session_id,
                    outline["title"],
                    "",
                    "outlined",
                    user_prompt,
                    outline["outline"],
                    outline["opening"],
                    partner_name,
                    persona,
                    model_key,
                    outline["ending_trigger"],
                    json.dumps(usage_report, ensure_ascii=False),
                    outline["background"],
                    outline["state"],
                    now,
                    now,
                ),
            )
        await db.commit()
        session = await _load_session(db, session_id)

    return {"session": session, "messages": [], "assets": assets, "usage": usage_report}


@router.post("/sessions/{session_id}/start")
async def start_session(session_id: str, body: DateStartRequest):
    now = time.time()
    async with get_db() as db:
        session = await _load_session(db, session_id)
        if not session:
            return Response(content=json.dumps({"error": "session not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        if session.get("status") not in {"outlined", "active"}:
            return Response(content=json.dumps({"error": "outline is required before starting"}, ensure_ascii=False), status_code=400, media_type="application/json")
        if body.model:
            session["model"] = _resolve_model(body.model, {"model": body.model, "model_locked": True})
            await db.execute("UPDATE date_sessions SET model=?, updated_at=? WHERE id=?", (session["model"], now, session_id))
        messages = await _load_messages(db, session_id)
        if session.get("status") != "active":
            msg_id = now_id("date_msg")
            await db.execute(
                "INSERT INTO date_messages (id, session_id, role, content, created_at, attachments) VALUES (?,?,?,?,?,?)",
                (
                    msg_id,
                    session_id,
                    "assistant",
                    session.get("opening") or "今晚先从这里开始，好吗？",
                    now + 0.001,
                    json.dumps([{"type": "date_stage", "background": session.get("current_background"), "state": session.get("current_state")}], ensure_ascii=False),
                ),
            )
            await db.execute("UPDATE date_sessions SET status='active', updated_at=? WHERE id=?", (now, session_id))
            await db.commit()
            session = await _load_session(db, session_id)
            messages = await _load_messages(db, session_id)
        else:
            await db.commit()

    return {"session": session, "messages": messages, "assets": scan_date_assets()}


@router.get("/sessions/{session_id}/messages")
async def get_messages(session_id: str):
    async with get_db() as db:
        return await _load_messages(db, session_id)


@router.get("/messages/{msg_id}/tts")
async def date_message_tts_urls(msg_id: str):
    return {
        "urls": list_date_message_tts_urls(
            msg_id,
            cache_dir=DATE_THEATER_TTS_CACHE_DIR,
            audio_url_prefix=DATE_TTS_AUDIO_PREFIX,
        )
    }


@router.delete("/messages/{msg_id}")
async def delete_message(msg_id: str):
    async with get_db() as db:
        deleted = await delete_date_message(db, msg_id)
        if not deleted:
            return Response(content=json.dumps({"error": "message not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        await db.commit()
        session = await _load_session(db, deleted["session_id"])
        messages = await _load_messages(db, deleted["session_id"])
    return {"ok": True, "deleted": deleted, "session": session, "messages": messages, "assets": scan_date_assets()}


@router.post("/sessions/{session_id}/send")
async def send_message(session_id: str, body: DateSendRequest):
    content = (body.content or "").strip()
    if not content:
        return Response(content=json.dumps({"error": "message is empty"}, ensure_ascii=False), status_code=400, media_type="application/json")

    now = time.time()
    user_msg_id = now_id("date_user")
    async with get_db() as db:
        session = await _load_session(db, session_id)
        if not session:
            return Response(content=json.dumps({"error": "session not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        if session.get("status") == "ended":
            return Response(content=json.dumps({"error": "session ended"}, ensure_ascii=False), status_code=400, media_type="application/json")
        if session.get("status") != "active":
            return Response(content=json.dumps({"error": "date has not started"}, ensure_ascii=False), status_code=400, media_type="application/json")
        await db.execute(
            "INSERT INTO date_messages (id, session_id, role, content, created_at, attachments) VALUES (?,?,?,?,?,?)",
            (user_msg_id, session_id, "user", content, now, "[]"),
        )
        await db.execute("UPDATE date_sessions SET updated_at=? WHERE id=?", (now, session_id))
        await db.commit()

    q: asyncio.Queue = asyncio.Queue()
    ai_msg_id = f"{now_id('date_ai')}_ai"
    cfg = load_date_config()
    user_name, _ai_name = _world_names()
    assets = scan_date_assets()
    model_key = _resolve_model(body.model or session.get("model") or "", cfg)

    tts_streamer = None
    if body.tts_enabled and body.tts_voice:
        tts_streamer = TTSStreamer(
            ai_msg_id,
            body.tts_voice,
            None,
            sse_queue=q,
            min_chars=DATE_TTS_MIN_CHARS,
            max_chars=DATE_TTS_MAX_CHARS,
            cache_dir=DATE_THEATER_TTS_CACHE_DIR,
            audio_url_prefix=DATE_TTS_AUDIO_PREFIX,
            merge_segments=True,
            delete_segments_after_seconds=None,
            cache_max_bytes=None,
        )

    async def _bg_generate():
        full_text = ""
        try:
            await q.put({"type": "start", "id": ai_msg_id, "user_msg_id": user_msg_id})
            async with get_db() as db:
                fresh_session = await _load_session(db, session_id) or session
                messages = await _load_messages(db, session_id, limit=60)

            history = [
                {
                    "role": "user",
                    "content": build_reply_prompt(
                        session=fresh_session,
                        partner_name=fresh_session.get("partner_name") or cfg.get("partner_name") or "AI",
                        user_name=user_name,
                        persona=fresh_session.get("persona") or cfg.get("persona") or "",
                        assets=assets,
                    ),
                },
                {"role": "assistant", "content": "收到，我只延续这场独立约会。"},
            ]
            history.extend({"role": m["role"], "content": m["content"]} for m in messages if m.get("role") in {"user", "assistant"})
            usage_meta: dict = {}

            try:
                async for chunk in stream_ai(history, model_key, usage_meta, temperature=body.temperature):
                    if chunk.startswith(CLI_STATUS_PREFIX):
                        await q.put({"type": "cli_status", "text": chunk[len(CLI_STATUS_PREFIX):]})
                        continue
                    full_text += chunk
                    await q.put({"type": "chunk", "content": chunk})
                    if tts_streamer:
                        tts_streamer.feed(chunk)
            except Exception as e:
                full_text += f"\n[请求出错: {e}]"

            visible_text, raw_commands = extract_stage_commands(full_text)
            visible_text = visible_text or "我在。"
            commands = _validated_commands(raw_commands, assets)
            music_cards = await asyncio.to_thread(_resolve_music_cards, commands.get("music") or [])
            attachments = _stage_attachment(commands, music_cards)
            usage_report = build_prompt_usage_report(
                purpose="reply",
                usage_meta=usage_meta,
                parts=[
                    {"label": "约会系统规则/本场人设/大纲/素材", "content": history[0]["content"]},
                    {"label": "约会内历史消息", "content": "\n".join(item["content"] for item in history[2:])},
                    {"label": "用户本次输入", "content": content},
                ],
            )
            attachments.append({"type": "usage", "usage": usage_report})
            now2 = time.time()

            async with get_db() as db:
                await db.execute(
                    "INSERT INTO date_messages (id, session_id, role, content, created_at, attachments) VALUES (?,?,?,?,?,?)",
                    (ai_msg_id, session_id, "assistant", visible_text, now2, json.dumps(attachments, ensure_ascii=False)),
                )
                updates = ["updated_at=?"]
                params: list = [now2]
                if commands.get("background"):
                    updates.append("current_background=?")
                    params.append(commands["background"])
                if commands.get("state"):
                    updates.append("current_state=?")
                    params.append(commands["state"])
                params.append(session_id)
                await db.execute(f"UPDATE date_sessions SET {', '.join(updates)} WHERE id=?", params)
                await db.commit()

            await q.put({
                "type": "message_final",
                "data": {
                    "id": ai_msg_id,
                    "session_id": session_id,
                    "role": "assistant",
                    "content": visible_text,
                    "created_at": now2,
                    "attachments": attachments,
                    "usage": usage_report,
                    "stage": commands,
                    "music": music_cards,
                    "end_ready": commands.get("end_ready"),
                },
            })
        finally:
            if tts_streamer:
                try:
                    await tts_streamer.flush()
                except Exception:
                    pass
            await q.put({"type": "done"})

    asyncio.create_task(_bg_generate())

    async def generate():
        while True:
            item = await q.get()
            if item.get("type") == "done":
                break
            yield f"data: {json.dumps(item, ensure_ascii=False)}\n\n"

    return StreamingResponse(generate(), media_type="text/event-stream")


@router.post("/sessions/{session_id}/end")
async def end_session(session_id: str):
    cfg = load_date_config()
    user_name, _ai_name = _world_names()
    async with get_db() as db:
        session = await _load_session(db, session_id)
        if not session:
            return Response(content=json.dumps({"error": "session not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        messages = await _load_messages(db, session_id, limit=80)

    fallback_summary = "这场约会已经自然结束。"
    if messages:
        tail = "；".join(m["content"] for m in messages[-3:] if m.get("content"))
        if tail:
            fallback_summary = tail[:160]
    prompt = build_end_prompt(
        session=session,
        messages=messages,
        partner_name=session.get("partner_name") or cfg.get("partner_name") or "AI",
        user_name=user_name,
    )
    try:
        raw, usage_meta = await _collect_ai_response([{"role": "user", "content": prompt}], _resolve_model(session.get("model") or "", cfg))
    except Exception:
        raw = ""
        usage_meta = {}
    result = parse_end_payload(raw, session.get("title") or "约会", fallback_summary)
    usage_report = build_prompt_usage_report(
        purpose="ending_summary",
        usage_meta=usage_meta,
        parts=[
            {"label": "结束总结规则和最近约会记录", "content": prompt},
        ],
    )
    now = time.time()

    async with get_db() as db:
        await db.execute(
            "UPDATE date_sessions SET title=?, summary=?, status='ended', end_usage=?, ended_at=?, updated_at=? WHERE id=?",
            (result["title"], result["summary"], json.dumps(usage_report, ensure_ascii=False), now, now, session_id),
        )
        await db.commit()
        session = await _load_session(db, session_id)
    return {"session": session, "usage": usage_report}


@router.get("/sync-target")
async def sync_target():
    async with get_db() as db:
        db.row_factory = aiosqlite.Row
        target = await find_last_chat_target(db, private_label=_private_label())
    return {"target": target}


@router.get("/sync-targets")
async def sync_targets():
    ai_name, connor_name = _sync_target_names()
    async with get_db() as db:
        db.row_factory = aiosqlite.Row
        targets = await list_summary_sync_targets(
            db,
            private_label=_private_label(),
            ai_name=ai_name,
            connor_name=connor_name,
        )
    default_target = next((item for item in targets if item.get("is_default")), targets[0] if targets else None)
    return {"targets": targets, "default_target": default_target}


@router.post("/sessions/{session_id}/sync")
async def sync_session(session_id: str, body: DateSyncRequest | None = None):
    async with get_db() as db:
        db.row_factory = aiosqlite.Row
        session = await _load_session(db, session_id)
        if not session:
            return Response(content=json.dumps({"error": "session not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        if not session.get("summary"):
            return Response(content=json.dumps({"error": "session summary is empty"}, ensure_ascii=False), status_code=400, media_type="application/json")
        if session.get("synced_at"):
            return {"ok": True, "already_synced": True, "target": session.get("synced_target") or ""}

        try:
            ai_name, connor_name = _sync_target_names()
            target = await resolve_sync_target(
                db,
                body.target_type if body else "",
                body.target_id if body else "",
                private_label=_private_label(),
                ai_name=ai_name,
                connor_name=connor_name,
            )
        except ValueError:
            return Response(content=json.dumps({"error": "sync target not found"}, ensure_ascii=False), status_code=404, media_type="application/json")
        title = session.get("title") or "约会"
        summary = session.get("summary") or ""
        content = build_sync_message(title, summary)
        msg = await insert_sync_message(db, target, content, attachment=build_sync_card_attachment(title, summary))
        target_key = f"chatroom:{msg['room_id']}" if msg.get("target_type") == "chatroom" else f"private:{msg['conv_id']}"
        await db.execute(
            "UPDATE date_sessions SET synced_at=?, synced_target=?, updated_at=? WHERE id=?",
            (time.time(), target_key, time.time(), session_id),
        )
        await db.commit()

    if msg.get("target_type") == "chatroom":
        data = {k: v for k, v in msg.items() if k != "target_type"}
        await manager.broadcast({"type": "chatroom_msg_created", "data": data})
    else:
        data = {k: v for k, v in msg.items() if k != "target_type"}
        await manager.broadcast({"type": "msg_created", "data": data})
    return {"ok": True, "target": target, "message": msg}


@router.head("/tts/audio/{msg_id}")
@router.get("/tts/audio/{msg_id}")
async def date_tts_audio(msg_id: str):
    safe_id = re.sub(r"[^a-zA-Z0-9_\-]", "", msg_id)
    if not safe_id:
        return Response(status_code=404)
    cache_path = DATE_THEATER_TTS_CACHE_DIR / f"{safe_id}.mp3"
    if not cache_path.exists():
        return Response(status_code=404)
    return FileResponse(cache_path, media_type="audio/mpeg", filename=f"{safe_id}.mp3")
