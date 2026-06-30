import sys
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import AsyncMock, Mock, patch


ROOT = Path(__file__).resolve().parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from routes import chat as chat_routes


class FakeCursor:
    def __init__(self, row=None):
        self.row = row

    async def fetchone(self):
        return self.row

    async def fetchall(self):
        return []


class FakeDb:
    def __init__(self):
        self.row_factory = None
        self.statements = []

    async def execute(self, sql, params=()):
        self.statements.append((sql, params))
        if "SELECT model FROM conversations" in sql:
            return FakeCursor({"model": "unit-model"})
        return FakeCursor()

    async def commit(self):
        return None


class FakeDbContext:
    async def __aenter__(self):
        return FakeDb()

    async def __aexit__(self, exc_type, exc, tb):
        return False


def fake_get_db():
    return FakeDbContext()


async def fake_stream_ai(*args, **kwargs):
    yield "regenerated"


class ChatRegenerateTests(unittest.IsolatedAsyncioTestCase):
    async def test_regenerate_uses_latest_user_message_as_recall_query(self):
        captured = {}

        def fake_build_recall_query(topic, keywords, *, query_text, recent_messages, status):
            captured["query_text"] = query_text
            captured["recent_messages"] = recent_messages
            return "unit recall query"

        async def fake_instant_digest(actual_recent):
            captured["actual_recent"] = actual_recent
            return {
                "keywords": [],
                "topic": "unit topic",
                "is_search_needed": False,
                "status": "ok",
            }

        rendered_history = [
            {"role": "user", "content": "older user prompt", "attachments": []},
            {"role": "assistant", "content": "older reply", "attachments": []},
            {"role": "user", "content": "latest user prompt", "attachments": []},
        ]

        patches = [
            patch("routes.chat.get_db", new=fake_get_db),
            patch("routes.chat.resolve_model_key", return_value="unit-model"),
            patch("routes.chat.fetch_merged_timeline", new=AsyncMock(return_value=[])),
            patch("routes.chat.render_merged_timeline", return_value=list(rendered_history)),
            patch("routes.chat.load_worldbook", return_value={}),
            patch("routes.chat._insert_private_ability_block", new=AsyncMock(return_value=0)),
            patch("routes.chat.instant_digest", new=fake_instant_digest),
            patch("routes.chat.build_health_summary", new=AsyncMock(return_value="")),
            patch("routes.chat.build_surfacing_memories", new=AsyncMock(return_value=([], set()))),
            patch("routes.chat._build_recall_query", side_effect=fake_build_recall_query),
            patch("routes.chat.recall_memories", new=AsyncMock(return_value=([], []))),
            patch("routes.chat.stream_ai", new=fake_stream_ai),
            patch("routes.chat.process_schedule_commands", new=AsyncMock(side_effect=lambda text, *a, **k: text)),
            patch("routes.chat._process_home_commands", new=AsyncMock(side_effect=lambda text: text)),
            patch("routes.chat.handle_luckin_commands", new=AsyncMock(side_effect=lambda text: (text, []))),
            patch("routes.chat._process_wish_commands", new=AsyncMock(side_effect=lambda text, **k: text)),
            patch("routes.chat._extract_reply_image_attachments", side_effect=lambda text: (text, [])),
            patch("routes.chat.luckin_payment_attachments", return_value=[]),
            patch("routes.chat.export_conversation", new=AsyncMock()),
            patch.object(chat_routes.manager, "broadcast", new=AsyncMock()),
            patch.object(chat_routes.manager, "set_tts_fallback", new=Mock()),
        ]
        with ExitStack() as stack:
            for item in patches:
                stack.enter_context(item)
            response = await chat_routes.regenerate_message("conv_test", context_limit=10)
            body = ""
            async for chunk in response.body_iterator:
                body += chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk

        self.assertEqual(captured["query_text"], "latest user prompt")
        self.assertEqual(captured["actual_recent"], rendered_history[-3:])
        self.assertIn('"type": "start"', body)
        self.assertIn("regenerated", body)


if __name__ == "__main__":
    unittest.main()
