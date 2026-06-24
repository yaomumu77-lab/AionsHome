from typing import Any, Optional
import time

from fastapi import APIRouter, Query
from pydantic import BaseModel

import xhs_lite


router = APIRouter(prefix="/api/xhs-lite", tags=["xhs-lite"])


class XhsActorConfig(BaseModel):
    enabled: Optional[bool] = None


class XhsConfigUpdate(BaseModel):
    enabled: Optional[bool] = None
    auto_enabled: Optional[bool] = None
    cookie: Optional[str] = None
    clear_cookie: Optional[bool] = None
    target_user_id: Optional[str] = None
    target_xsec_token: Optional[str] = None
    target_nickname: Optional[str] = None
    target_profile_url: Optional[str] = None
    task_instruction: Optional[str] = None
    use_following_list: Optional[bool] = None
    max_following_pages: Optional[int] = None
    allow_write_comments: Optional[bool] = None
    write_delay_seconds: Optional[float] = None
    max_comments_for_prompt: Optional[int] = None
    comment_signature_template: Optional[str] = None
    actors: Optional[dict[str, XhsActorConfig]] = None


class XhsRunRequest(BaseModel):
    actor: str = "aion"


@router.get("/config")
async def get_config():
    return xhs_lite.public_config()


@router.put("/config")
async def update_config(body: XhsConfigUpdate):
    updates: dict[str, Any] = {}
    for key in (
        "enabled",
        "auto_enabled",
        "target_user_id",
        "target_xsec_token",
        "target_nickname",
        "target_profile_url",
        "task_instruction",
        "use_following_list",
        "allow_write_comments",
        "comment_signature_template",
    ):
        value = getattr(body, key)
        if value is not None:
            updates[key] = value
    if body.max_following_pages is not None:
        updates["max_following_pages"] = max(1, min(10, int(body.max_following_pages)))
    if body.write_delay_seconds is not None:
        updates["write_delay_seconds"] = max(5.0, float(body.write_delay_seconds))
    if body.max_comments_for_prompt is not None:
        updates["max_comments_for_prompt"] = max(5, min(50, int(body.max_comments_for_prompt)))
    if body.clear_cookie:
        updates["cookie"] = ""
    elif body.cookie is not None and body.cookie.strip():
        updates["cookie"] = body.cookie.strip()
    if body.actors is not None:
        updates["actors"] = {
            actor: actor_cfg.dict(exclude_none=True)
            for actor, actor_cfg in body.actors.items()
            if actor in ("aion", "connor")
        }
    xhs_lite.save_config(updates)
    return {"ok": True, "config": xhs_lite.public_config()}


@router.post("/check-login")
async def check_login():
    try:
        result = await xhs_lite.check_login()
        account = {
            "logged_in": bool(result.get("logged_in")),
            "nickname": result.get("nickname") or "",
            "user_id": result.get("user_id") or "",
            "red_id": result.get("red_id") or "",
        }
        xhs_lite.save_config({
            "logged_in_nickname": account["nickname"],
            "logged_in_user_id": account["user_id"],
            "logged_in_red_id": account["red_id"],
            "last_login_check_at": time.time(),
        })
        return {"ok": True, "account": account}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/followings")
async def followings():
    try:
        users = await xhs_lite.list_followings()
        return {"ok": True, "users": users}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "users": []}


@router.post("/run-once")
async def run_once(body: XhsRunRequest):
    try:
        result = await xhs_lite.run_actor_roam(body.actor, manual=True)
        return {"ok": True, "result": result}
    except Exception as exc:
        return {"ok": False, "error": str(exc)}


@router.get("/logs")
async def logs(limit: int = Query(default=50, ge=1, le=300)):
    return {"items": xhs_lite.read_logs(limit)}
